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

  /**
   * Получает user_id из localStorage
   * Ключ 'm004_user_id' устанавливается в app.js после identity resolution
   */
  getUserId() {
    const userId = localStorage.getItem('m004_user_id');
    if (!userId) {
      console.warn('[API] user_id not found in localStorage. Identity may not be resolved.');
      // Генерируем временный ID для режима без оболочки
      const tempId = 'usr_dev_' + crypto.randomUUID().substring(0, 8);
      localStorage.setItem('m004_user_id', tempId);
      return tempId;
    }
    return userId;
  },

  /**
   * Получает shell_id из URL параметра
   */
  getShellId() {
    const params = new URLSearchParams(window.location.search);
    return params.get('shell') || null;
  },

  /**
   * Получает origin_url для определения оболочки
   */
  getOriginUrl() {
    return window.location.href;
  },

  async getBalance() {
    const userId = this.getUserId();
    const shellId = this.getShellId();
    const originUrl = this.getOriginUrl();

    let url = `${this.baseUrl}/balance?user_id=${encodeURIComponent(userId)}`;
    if (shellId) {
      url += `&shell_id=${encodeURIComponent(shellId)}`;
    }
    url += `&origin_url=${encodeURIComponent(originUrl)}`;

    const response = await fetch(url);

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to get balance');
    }

    return response.json();
  },

  async startResearch(query, options = {}) {
    const userId = this.getUserId();
    const shellId = this.getShellId();
    const originUrl = this.getOriginUrl();

    const response = await fetch(`${this.baseUrl}/research`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        user_id: userId,
        shell_id: shellId,
        origin_url: originUrl,
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
    const response = await fetch(`${this.baseUrl}/research/${researchId}/clarify`, {
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
    const response = await fetch(`${this.baseUrl}/research/${researchId}`);

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to get research');
    }

    return response.json();
  },

  async getHistory(limit = 20, offset = 0) {
    const userId = this.getUserId();
    const response = await fetch(
      `${this.baseUrl}/research/user/history?user_id=${encodeURIComponent(userId)}&limit=${limit}&offset=${offset}`
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to get history');
    }

    return response.json();
  },

  getExportUrl(researchId, format) {
    return `${this.baseUrl}/research/${researchId}/export?format=${format}`;
  }
};

window.api = api;
