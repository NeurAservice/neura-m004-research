/**
 * @file public/js/api.js
 * @description API клиент для NeurA Research
 * @context Используется app.js для запросов к backend
 */

// Determine API base path from current location
const API_BASE_URL = (function() {
  const path = window.location.pathname;
  if (path.includes('/m004')) {
    return '/m004/api';
  }
  return '/api';
})();

const api = {
  baseUrl: API_BASE_URL,

  getUserId() {
    let userId = localStorage.getItem('neura-research-user-id');
    if (!userId) {
      userId = 'user_' + crypto.randomUUID();
      localStorage.setItem('neura-research-user-id', userId);
    }
    return userId;
  },

  async getBalance() {
    const userId = this.getUserId();
    const response = await fetch(`${this.baseUrl}/api/balance?user_id=${encodeURIComponent(userId)}`);

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to get balance');
    }

    return response.json();
  },

  async startResearch(query, options = {}) {
    const userId = this.getUserId();

    const response = await fetch(`${this.baseUrl}/api/research`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        user_id: userId,
        options,
      }),
    });

    if (!response.ok && !response.headers.get('content-type')?.includes('text/event-stream')) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to start research');
    }

    return response;
  },

  async submitClarification(researchId, answers) {
    const response = await fetch(`${this.baseUrl}/api/research/${researchId}/clarify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ answers }),
    });

    if (!response.ok && !response.headers.get('content-type')?.includes('text/event-stream')) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to submit clarification');
    }

    return response;
  },

  async getResearch(researchId) {
    const response = await fetch(`${this.baseUrl}/api/research/${researchId}`);

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to get research');
    }

    return response.json();
  },

  async getHistory(limit = 20, offset = 0) {
    const userId = this.getUserId();
    const response = await fetch(
      `${this.baseUrl}/api/research/user/history?user_id=${encodeURIComponent(userId)}&limit=${limit}&offset=${offset}`
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to get history');
    }

    return response.json();
  },

  getExportUrl(researchId, format) {
    return `${this.baseUrl}/api/research/${researchId}/export?format=${format}`;
  }
};

window.api = api;
