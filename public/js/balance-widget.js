/**
 * @file public/js/balance-widget.js
 * @description Единый виджет баланса для всех страниц модуля m004
 * @context Вынесен в отдельный файл для единообразия на index.html и history.html
 * @dependencies js/api.js, js/i18n.js
 */

const balanceWidget = {
  topupUrl: null,

  /**
   * Инициализирует виджет баланса: привязывает события
   */
  init() {
    const balanceToggle = document.getElementById('balance-toggle');
    if (balanceToggle) {
      balanceToggle.addEventListener('click', () => this.toggle());
    }

    const balanceClose = document.getElementById('balance-close');
    if (balanceClose) {
      balanceClose.addEventListener('click', () => this.close());
    }

    const balanceRefresh = document.getElementById('balance-refresh');
    if (balanceRefresh) {
      balanceRefresh.addEventListener('click', () => this.fetchBalance());
    }

    // Закрытие по клику вне области
    document.addEventListener('click', (e) => {
      const popover = document.getElementById('balance-popover');
      const toggle = document.getElementById('balance-toggle');
      if (popover && toggle && !popover.contains(e.target) && !toggle.contains(e.target)) {
        this.close();
      }
    });
  },

  /**
   * Переключает видимость попапа баланса
   */
  toggle() {
    const popover = document.getElementById('balance-popover');
    if (popover) {
      const isHidden = popover.hidden;
      popover.hidden = !isHidden;
      if (!popover.hidden) {
        this.fetchBalance();
      }
    }
  },

  /**
   * Закрывает попап баланса
   */
  close() {
    const popover = document.getElementById('balance-popover');
    if (popover) {
      popover.hidden = true;
    }
  },

  /**
   * Загружает баланс с сервера и обновляет UI
   */
  async fetchBalance() {
    const valueEl = document.getElementById('balance-value');
    const updatedEl = document.getElementById('balance-updated');
    const topupBtn = document.getElementById('balance-topup');

    if (valueEl) valueEl.textContent = '...';

    try {
      const result = await api.getBalance();

      if (result.status === 'success' && result.data) {
        const balance = result.data.balance;
        this.topupUrl = result.data.topup_url || null;

        if (valueEl) {
          valueEl.textContent = typeof balance === 'number' ? balance.toFixed(2) : balance;
        }
        if (updatedEl) {
          const locale = (typeof i18n !== 'undefined' && i18n.locale === 'en') ? 'en-US' : 'ru-RU';
          const time = new Date().toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
          const label = (typeof i18n !== 'undefined') ? i18n.t('balance.updatedAt') : 'Обновлено';
          updatedEl.textContent = `${label}: ${time}`;
        }
        this.updateTopupLink();
      } else {
        throw new Error(result.message || 'Balance fetch failed');
      }
    } catch (error) {
      console.error('[BalanceWidget] Failed to fetch balance:', error);
      if (valueEl) valueEl.textContent = '--';
      if (updatedEl) {
        const label = (typeof i18n !== 'undefined') ? i18n.t('balance.error') : 'Ошибка загрузки';
        updatedEl.textContent = label;
      }
    }
  },

  /**
   * Обновляет ссылку «Пополнить» в зависимости от наличия topup_url
   */
  updateTopupLink() {
    const topupBtn = document.getElementById('balance-topup');
    if (!topupBtn) return;

    if (this.topupUrl) {
      topupBtn.href = this.topupUrl;
      topupBtn.target = '_blank';
      topupBtn.rel = 'noopener noreferrer';
      topupBtn.onclick = null;
    } else {
      topupBtn.href = '#';
      topupBtn.removeAttribute('target');
      topupBtn.onclick = (e) => {
        e.preventDefault();
        const msg = (typeof i18n !== 'undefined')
          ? (i18n.t('errors.topupUnavailable') || 'Ссылка для пополнения недоступна')
          : 'Ссылка для пополнения недоступна';
        balanceWidget.showToast(msg, 'error');
      };
    }
  },

  /**
   * Показывает toast-уведомление
   */
  showToast(message, type = 'info') {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
  }
};

window.balanceWidget = balanceWidget;
