/**
 * @file public/js/i18n.js
 * @description Интернационализация
 */

const i18n = {
  locale: 'ru',
  translations: {},

  async init() {
    const savedLocale = localStorage.getItem('neura-research-locale') || 'ru';
    await this.setLocale(savedLocale);
  },

  async setLocale(locale) {
    try {
      const response = await fetch(`locales/${locale}.json`);
      if (!response.ok) throw new Error('Failed to load locale');
      this.translations = await response.json();
      this.locale = locale;
      localStorage.setItem('neura-research-locale', locale);
      this.updatePageTexts();
    } catch (error) {
      console.error('i18n error:', error);
      if (locale !== 'ru') {
        await this.setLocale('ru');
      }
    }
  },

  t(key, params = {}) {
    const keys = key.split('.');
    let value = this.translations;

    for (const k of keys) {
      if (value && typeof value === 'object' && k in value) {
        value = value[k];
      } else {
        return key;
      }
    }

    if (typeof value !== 'string') return key;

    // Replace params
    return value.replace(/\{(\w+)\}/g, (match, paramKey) => {
      return params[paramKey] !== undefined ? params[paramKey] : match;
    });
  },

  updatePageTexts() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      el.textContent = this.t(key);
    });

    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.getAttribute('data-i18n-placeholder');
      el.placeholder = this.t(key);
    });

    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      const key = el.getAttribute('data-i18n-title');
      el.title = this.t(key);
    });
  }
};

window.i18n = i18n;
