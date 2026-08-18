// Publishes buffered receptions to MQTT (over WebSocket/TLS) in the
// meshcoretomqtt-compatible format CoreScope's ingestor consumes, on the
// client topic meshcore/client/{PUBLIC_KEY}/packets.
import mqtt from 'mqtt';

export class Publisher {
  // opts: { url, username, password } — EMQX WSS endpoint + per-client creds.
  constructor(opts) { this.opts = opts; this.client = null; this._onStatus = null; }

  // onStatus(cb): cb(state, arg) is called on connection lifecycle changes, where state
  // is 'connect' | 'reconnect' | 'offline' | 'close' | 'error' (arg = Error for 'error').
  // Drives the Home upload indicator, the debug log, and a drain kick on reconnect.
  onStatus(cb) { this._onStatus = cb; }

  _emit(ev, arg) { if (this._onStatus) this._onStatus(ev, arg); }

  connect() {
    this.client = mqtt.connect(this.opts.url, {
      username: this.opts.username,
      password: this.opts.password,
      clientId: this.opts.clientId, // = companion pubkey; EMQX ACL can bind topics to ${clientid}
      reconnectPeriod: 4000,
      clean: true,
    });
    for (const ev of ['connect', 'reconnect', 'offline', 'close']) {
      this.client.on(ev, () => this._emit(ev));
    }
    // PERSISTENT error listener. mqtt.js is an EventEmitter: an 'error' with no listener
    // throws and can wedge the auto-reconnect loop — which left the client permanently
    // disconnected (every reception stuck pending) after one transient drop. Always
    // listen and surface the reason instead.
    this.client.on('error', (e) => this._emit('error', e));
    // Resolve/reject the INITIAL connect only. Listeners are removed once settled so the
    // persistent 'error' handler above is the sole long-lived one afterwards.
    return new Promise((resolve, reject) => {
      const onConn = () => { cleanup(); resolve(); };
      const onErr = (e) => { cleanup(); reject(e); };
      const cleanup = () => { this.client.removeListener('connect', onConn); this.client.removeListener('error', onErr); };
      this.client.on('connect', onConn);
      this.client.on('error', onErr);
    });
  }

  connected() { return !!(this.client && this.client.connected); }

  // reconnect forces a fresh connection attempt — used by "Push pending now" when the
  // client is disconnected, so the user isn't stuck with a dead link and a full queue.
  reconnect() { try { if (this.client) this.client.reconnect(); } catch (e) {} }

  end() { try { if (this.client) this.client.end(true); } catch (e) {} this.client = null; }

  // buildPayload assembles one reception in the ingestor's expected shape.
  // `name` is the companion's self-reported name (SELF_INFO) → sent as "origin"
  // so the server can label this observer even if it never advertised.
  static buildPayload(rxPubkey, rec, name) {
    return {
      origin_id: rxPubkey,
      origin: name || undefined,
      timestamp: rec.rx_at,
      type: 'PACKET',
      direction: 'rx',
      raw: rec.raw,
      SNR: rec.snr,
      RSSI: rec.rssi,
      gps: { lat: rec.lat, lon: rec.lon, acc_m: rec.acc_m },
    };
  }

  // buildRfPayload assembles one RF environment sample. Additive: a new type on
  // a new topic, so the /packets contract is unaffected.
  static buildRfPayload(rxPubkey, rec, name) {
    const p = {
      origin_id: rxPubkey,
      origin: name || undefined,
      timestamp: rec.at,
      type: 'RF_SAMPLE',
      gps: { lat: rec.lat, lon: rec.lon, acc_m: rec.acc_m },
      stationary: !!rec.stationary,
      uptime_secs: rec.uptime_secs,
      battery_mv: rec.battery_mv,
      queue_len: rec.queue_len,
      errors: rec.errors,
      noise_floor: rec.noise_floor,
      last_rssi: rec.last_rssi,
      last_snr: rec.last_snr,
      tx_air_secs: rec.tx_air_secs,
      rx_air_secs: rec.rx_air_secs,
      recv: rec.recv,
      sent: rec.sent,
      flood_rx: rec.flood_rx,
      direct_rx: rec.direct_rx,
      flood_tx: rec.flood_tx,
      direct_tx: rec.direct_tx,
    };
    if ('recv_errors' in rec) p.recv_errors = rec.recv_errors;
    return p;
  }

  // topicFor / payloadFor dispatch on rec.kind. A record with NO kind is a
  // reception queued before this feature existed — it must keep working.
  static topicFor(rxPubkey, rec) {
    return 'meshcore/client/' + rxPubkey + (rec.kind === 'rf' ? '/rf' : '/packets');
  }

  static payloadFor(rxPubkey, rec, name) {
    return rec.kind === 'rf'
      ? Publisher.buildRfPayload(rxPubkey, rec, name)
      : Publisher.buildPayload(rxPubkey, rec, name);
  }

  // publish sends one reception; resolves on broker ack (QoS1). A dead socket never
  // acks, so the callback would hang forever — the timeout rejects instead, the record
  // stays buffered, and the drain loop lives on to retry after reconnect.
  publish(rxPubkey, rec, name, timeoutMs = 8000) {
    const topic = Publisher.topicFor(rxPubkey, rec);
    const payload = JSON.stringify(Publisher.payloadFor(rxPubkey, rec, name));
    const ack = new Promise((resolve, reject) => {
      this.client.publish(topic, payload, { qos: 1 }, (err) => (err ? reject(err) : resolve()));
    });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('publish timeout')), timeoutMs));
    return Promise.race([ack, timeout]);
  }
}
