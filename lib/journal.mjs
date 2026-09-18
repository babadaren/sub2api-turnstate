import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class Journal {
  constructor(home, config) {
    this.file = path.join(home, 'records.jsonl');
    this.config = config;
    this.recent = [];
    this.pending = 0;
    this.dropped = 0;
    this.queue = Promise.resolve();
    this.total = { requests: 0, failures: 0, removedHeaders: 0, websocketHandshakes: 0 };
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    // Only the bounded current file is read. Cumulative counters are since process start.
    if (fs.existsSync(this.file) && fs.statSync(this.file).size <= config.maxLogBytes + 16384) {
      for (const line of fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).slice(-config.recentLimit)) {
        try { this.recent.push(JSON.parse(line)); } catch {}
      }
    }
    this.bytes = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
  }
  add(record) {
    const event = { id: randomUUID(), time: new Date().toISOString(), ...record };
    if (event.kind === 'request') {
      this.total.requests++;
      if (event.status >= 400 || event.error) this.total.failures++;
      this.total.removedHeaders += Number(['drop312','discard','inject','reuse'].includes(event.requestAction)) + Number(['drop312','discard','inject','reuse'].includes(event.responseAction));
      if (event.protocol === 'websocket') this.total.websocketHandshakes++;
    }
    this.recent.push(event);
    if (this.recent.length > this.config.recentLimit) this.recent.shift();
    if (this.pending >= 512) { this.dropped++; return; }
    const line = JSON.stringify(event) + '\n';
    this.pending++;
    this.queue = this.queue.then(async () => {
      if (this.bytes + Buffer.byteLength(line) > this.config.maxLogBytes) {
        await fsp.rm(`${this.file}.${this.config.logFiles}`, { force: true });
        for (let n = this.config.logFiles - 1; n >= 1; n--) {
          try { await fsp.rename(`${this.file}.${n}`, `${this.file}.${n + 1}`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        }
        try { await fsp.rename(this.file, `${this.file}.1`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        this.bytes = 0;
      }
      await fsp.appendFile(this.file, line, { mode: 0o600 });
      this.bytes += Buffer.byteLength(line);
    }).catch(() => { this.dropped++; }).finally(() => { this.pending--; });
  }
  async flush() { await this.queue; }
}
