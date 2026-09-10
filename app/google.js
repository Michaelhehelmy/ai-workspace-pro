/**
 * app/google.js - Google Identity & Sheets Integration
 */

import { isBrowser } from '../core/env.js';
import { state } from '../core/state.js';
import { showToast } from './ui.js';

export class GoogleAPI {
  constructor(stateInstance, dbInstance) {
    this.state = stateInstance;
    this.db = dbInstance;
    this.tokenClient = null;
  }

  extractClientId() {
    const cfg = this.state.config;
    if (cfg && cfg.app && cfg.app.google && cfg.app.google.clientId) {
      return cfg.app.google.clientId;
    }
    return null;
  }

  async init() {
    if (!isBrowser) return false;
    const clientId = this.extractClientId();
    if (!clientId) {
      console.warn('GoogleAPI.init: no clientId configured');
      return false;
    }
    try {
      const savedToken = await this.db.getKV('google_token');
      if (savedToken) {
        this.setToken(savedToken);
        this.updateUI();
      }
      if (window.google && window.google.accounts) {
        this.tokenClient = window.google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
          callback: (tokenResponse) => this.handleTokenResponse(tokenResponse)
        });
      } else {
        const css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = 'https://fonts.googleapis.com/css2?family=Roboto:wght@400;500&display=swap';
        document.head.appendChild(css);

        const script = document.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client';
        script.async = true;
        script.defer = true;
        script.onload = () => {
          if (window.google && window.google.accounts) {
            this.tokenClient = window.google.accounts.oauth2.initTokenClient({
              client_id: clientId,
              scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
              callback: (tokenResponse) => this.handleTokenResponse(tokenResponse)
            });
            this.updateUI();
          }
        };
        document.head.appendChild(script);
      }
      return true;
    } catch (e) {
      console.warn('GoogleAPI.init error:', e.message);
      return false;
    }
  }

  handleTokenResponse(response) {
    if (response && response.access_token) {
      this.setToken(response.access_token);
      this.db.setKV('google_token', response.access_token).catch(() => {});
      this.updateUI();
      showToast('Google authenticated successfully', 'success');
    } else if (response && response.error) {
      showToast(`Google auth failed: ${response.error}`, 'danger');
    }
  }

  signIn() {
    if (!isBrowser) return;
    if (!this.tokenClient) {
      this.init().then(() => {
        if (this.tokenClient) this.tokenClient.requestAccessToken();
      });
      return;
    }
    this.tokenClient.requestAccessToken();
  }

  signOut() {
    if (!isBrowser) return;
    this.state.token = null;
    this.db.deleteKV('google_token').catch(() => {});
    this.updateUI();
    showToast('Signed out of Google', 'secondary');
  }

  setToken(token) {
    this.state.token = token;
  }

  getToken() {
    return this.state.token;
  }

  isSignedIn() {
    return Boolean(this.state.token);
  }

  updateUI() {
    if (!isBrowser) return;
    const statusEl = document.getElementById('googleStatus');
    const btn = document.getElementById('googleSignInBtn');
    if (statusEl) {
      statusEl.textContent = this.isSignedIn() ? '✓ Connected' : 'Not connected';
      statusEl.className = 'badge ' + (this.isSignedIn() ? 'bg-success' : 'bg-secondary');
    }
    if (btn) {
      btn.textContent = this.isSignedIn() ? 'Sign Out' : 'Sign In with Google';
      btn.classList.toggle('btn-danger', this.isSignedIn());
      btn.classList.toggle('btn-primary', !this.isSignedIn());
    }
  }

  async listCalendarEvents() {
    if (!this.isSignedIn() || !isBrowser) {
      return { text: '### 📅 Google Calendar\n\nNot connected or unavailable. ⚠️ Sign in with Google to sync your upcoming events.' };
    }
    const url = 'https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=10';
    const res = await fetch(url, { headers: { Authorization: `Bearer ${this.state.token}` } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Google Calendar API error ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    const items = (data.items || []).map(e => {
      const start = (e.start && (e.start.dateTime || e.start.date)) || '';
      return `- **${e.summary}** (${start})`;
    }).join('\n');
    return { text: `### 📅 Google Calendar\n\n${items || 'No upcoming events found.'}` };
  }

  async listDriveFiles() {
    if (!this.isSignedIn() || !isBrowser) {
      return { text: '### 📁 Google Drive\n\nNot connected or unavailable. ⚠️ Sign in with Google to browse your files.' };
    }
    const url = 'https://www.googleapis.com/drive/v3/files?pageSize=10&fields=files(id,name,mimeType)';
    const res = await fetch(url, { headers: { Authorization: `Bearer ${this.state.token}` } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Google Drive API error ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    const items = (data.files || []).map(f => `- **${f.name}** (${f.mimeType})`).join('\n');
    return { text: `### 📁 Google Drive\n\n${items || 'No files found.'}` };
  }

  async readSheet(spreadsheetId, range = 'A1:Z100') {
    if (!this.isSignedIn()) {
      throw new Error('Google not authenticated. Sign in first.');
    }
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.state.token}` }
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Google Sheets API error ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    return data.values || [];
  }
}