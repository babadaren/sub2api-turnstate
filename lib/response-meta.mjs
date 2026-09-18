import { validModel } from './states.mjs';

// Bounded, read-only response inspection. Never retain output/input text in logs.
// The forwarding path calls push() without delaying or replacing any stream byte.
export class ResponseMetadata {
  constructor(headers = {}, limit = 65536) {
    this.sse = String(headers['content-type'] || '').includes('text/event-stream');
    this.enabled = !headers['content-encoding'] && (this.sse || String(headers['content-type'] || '').includes('json'));
    this.limit = limit; this.bytes = 0; this.buffer = ''; this.model = null;
    this.completed = false; this.failed = false; this.outputLimitReached = false; this.truncated = false;
  }
  object(value) {
    if (!value || typeof value !== 'object') return;
    const response = value.response && typeof value.response === 'object' ? value.response : value;
    if (!this.model && validModel(response.model)) this.model = response.model;
    if (value.type === 'error' || value.type === 'response.failed' || value.error || response.error || response.status === 'failed') this.failed = true;
    if (value.type === 'response.completed' || response.status === 'completed') this.completed = true;
    if (value.type === 'response.incomplete' || response.status === 'incomplete') {
      if (response.incomplete_details?.reason === 'max_output_tokens') this.outputLimitReached = true;
      else this.failed = true;
    }
  }
  parse(raw) { try { this.object(JSON.parse(raw)); } catch {} }
  push(chunk) {
    if (!this.enabled || this.truncated) return;
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const available = Math.max(0, this.limit - this.bytes);
    this.bytes += part.length;
    this.buffer += part.subarray(0, available).toString('utf8');
    if (this.sse) {
      let index;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index).trim(); this.buffer = this.buffer.slice(index + 1);
        if (line.startsWith('data:')) this.parse(line.slice(5).trim());
      }
    }
    if (this.bytes > this.limit) { this.truncated = true; this.buffer = ''; }
  }
  end() {
    if (!this.truncated) {
      if (this.sse) { const line = this.buffer.trim(); if (line.startsWith('data:')) this.parse(line.slice(5).trim()); }
      else this.parse(this.buffer);
    }
    this.buffer = '';
  }
}
