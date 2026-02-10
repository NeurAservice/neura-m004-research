/**
 * @file public/js/app.js
 * @description Основной модуль приложения NeurA Research
 * @context Главный UI-контроллер: форма, SSE-прогресс, результат, экспорт
 * @dependencies js/api.js, js/i18n.js, js/balance-widget.js
 */

// Determine API base path from current location
const API_BASE = (function() {
  const path = window.location.pathname;
  if (path.includes('/m004')) {
    return '/m004/api';
  }
  return '/api';
})();

const app = {
  currentResearchId: null,
  eventSource: null,
  abortController: null,
  version: 'loading...',
  userId: null,

  async init() {
    await i18n.init();
    await this.loadModuleConfig();
    await this.initializeUser();
    this.bindEvents();
    this.initTextareaAutoResize();
    balanceWidget.init();
    this.checkPendingResearch();
  },

  /**
   * Load module configuration from server (name, version)
   */
  async loadModuleConfig() {
    try {
      const healthPath = API_BASE.replace('/api', '/health');
      const response = await fetch(healthPath);
      const data = await response.json();

      // Health returns { module: { version, name } }
      const version = data.module?.version || data.version;
      const name = data.module?.name || data.moduleName;

      if (version) {
        this.version = version;
        const versionBadge = document.getElementById('version-badge');
        if (versionBadge) {
          versionBadge.textContent = `v${version}`;
        }
        console.log(`[M004] Version from server: ${version}`);
      }

      if (name) {
        const moduleNameEl = document.getElementById('module-name');
        if (moduleNameEl) {
          moduleNameEl.textContent = name;
        }
      }
    } catch (error) {
      console.error('[M004] Failed to load module config:', error);
      const versionBadge = document.getElementById('version-badge');
      if (versionBadge) {
        versionBadge.textContent = 'v?';
      }
    }
  },

  /**
   * Initialize user from URL params with identity resolution
   */
  async initializeUser() {
    const params = new URLSearchParams(window.location.search);
    const studentId = params.get('studentId');
    const schoolNumber = params.get('schoolNumber');

    if (studentId && schoolNumber) {
      // Shell integration mode - resolve identity through CORE
      await this.resolveIdentity(studentId, schoolNumber);
    } else {
      // Direct access mode - use stored or generate user ID
      this.userId = localStorage.getItem('m004_user_id');
      if (!this.userId) {
        this.userId = 'usr_dev_' + crypto.randomUUID().substring(0, 8);
        localStorage.setItem('m004_user_id', this.userId);
      }
      console.log('[M004] Using local user ID:', this.userId);
    }
  },

  /**
   * Resolve identity through CORE API
   */
  async resolveIdentity(studentId, schoolNumber) {
    try {
      const response = await fetch(`${API_BASE}/identity/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'prodamus_xl',
          tenant: `xl:${schoolNumber}`,
          external_user_id: studentId
        })
      });

      const data = await response.json();

      if (data.success) {
        this.userId = data.user_id;
        localStorage.setItem('m004_user_id', this.userId);
        console.log('[M004] Identity resolved:', this.userId);
      } else {
        console.error('[M004] Identity resolution failed:', data.error);
        this.showToast(i18n.t('errors.identityFailed'), 'error');
      }
    } catch (error) {
      console.error('[M004] Identity resolution error:', error);
    }
  },

  /**
   * Get shell_id from URL parameter
   */
  getExplicitShellId() {
    const params = new URLSearchParams(window.location.search);
    return params.get('shell') || null;
  },

  /**
   * Get origin_url for shell detection
   */
  getShellOriginUrl() {
    const referrer = document.referrer;
    if (referrer) {
      try {
        const referrerUrl = new URL(referrer);
        if (referrerUrl.hostname.endsWith('.xl.ru') || referrerUrl.hostname === 'xl.ru') {
          return referrer;
        }
      } catch (e) {
        // Ignore
      }
    }
    return window.location.href;
  },

  bindEvents() {
    // Research form
    const form = document.getElementById('research-form');
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        this.startResearch();
      });
    }

    // Language selector
    const langSelect = document.getElementById('language-select');
    if (langSelect) {
      langSelect.value = i18n.locale;
      langSelect.addEventListener('change', (e) => {
        i18n.setLocale(e.target.value);
      });
    }
  },

  /**
   * Инициализирует авто-ресайз textarea (min текущая высота, max 500px)
   */
  initTextareaAutoResize() {
    const textarea = document.getElementById('query-input');
    if (!textarea) return;

    const adjustHeight = () => {
      textarea.style.height = 'auto';
      const scrollHeight = textarea.scrollHeight;
      textarea.style.height = Math.min(scrollHeight, 500) + 'px';
    };

    textarea.addEventListener('input', adjustHeight);
    // Начальная подгонка
    adjustHeight();
  },

  /**
   * Проверяет наличие незавершённого исследования и восстанавливает прогресс
   */
  checkPendingResearch() {
    const pendingId = localStorage.getItem('m004_pending_research');
    if (!pendingId) return;

    // Проверяем статус на сервере
    this.pollResearchStatus(pendingId);
  },

  /**
   * Периодически проверяет статус исследования (при обновлении страницы)
   */
  async pollResearchStatus(researchId) {
    this.currentResearchId = researchId;
    this.showProgressUI();
    this.updateProgress(50, i18n.t('progress.resuming') || 'Восстановление прогресса...');

    const poll = async () => {
      try {
        const result = await api.getResearch(researchId);
        if (result.status === 'success' && result.data) {
          const data = result.data;
          if (data.status === 'completed' && data.result) {
            localStorage.removeItem('m004_pending_research');
            this.updateProgress(100, i18n.t('progress.output'));
            this.showResult(data.result, data.result.quality);
            return;
          } else if (data.status === 'failed') {
            localStorage.removeItem('m004_pending_research');
            this.showToast(i18n.t('errors.unknown'), 'error');
            this.hideProgressUI();
            return;
          }
          // Ещё в процессе — продолжаем polling
          setTimeout(poll, 3000);
        }
      } catch (error) {
        console.error('[M004] Poll error:', error);
        localStorage.removeItem('m004_pending_research');
        this.hideProgressUI();
      }
    };

    await poll();
  },

  // Balance widget delegated to balance-widget.js

  async startResearch() {
    const queryInput = document.getElementById('query-input');
    const query = queryInput?.value.trim();

    if (!query) {
      this.showToast(i18n.t('errors.validationError'), 'error');
      return;
    }

    // Get options
    const options = {
      mode: document.getElementById('mode-select')?.value || 'standard',
      researchType: document.getElementById('type-select')?.value || 'facts_and_analysis',
      language: document.getElementById('language-select')?.value || 'ru',
    };

    // Show progress UI
    this.showProgressUI();
    this.disableForm(true);

    try {
      const response = await api.startResearch(query, options);
      await this.handleSSEResponse(response);
    } catch (error) {
      console.error('Research failed:', error);
      localStorage.removeItem('m004_pending_research');
      this.showToast(error.message, 'error');
      this.hideProgressUI();
    } finally {
      this.disableForm(false);
    }
  },

  async handleSSEResponse(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const event = JSON.parse(line.slice(6));
              this.handleEvent(event);
            } catch (e) {
              console.warn('Failed to parse SSE event:', e);
            }
          }
        }
      }
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.error('SSE error:', error);
        this.showToast(i18n.t('errors.network'), 'error');
      }
    }
  },

  handleEvent(event) {
    console.log('Event:', event);

    switch (event.type) {
      case 'started':
        this.currentResearchId = event.research_id;
        // Сохраняем ID для восстановления при обновлении страницы
        localStorage.setItem('m004_pending_research', event.research_id);
        this.updateProgress(0, i18n.t('progress.preparing'));
        break;

      case 'progress':
        this.updateProgress(event.progress, event.message || '');
        if (event.phase) {
          this.updatePhase(event.phase);
        }
        break;

      case 'phase_complete':
        this.markPhaseComplete(event.phase);
        break;

      case 'clarification_needed':
        this.showClarificationUI(event.questions, event.research_id);
        break;

      case 'completed':
        localStorage.removeItem('m004_pending_research');
        this.updateProgress(100, i18n.t('progress.output'));
        this.showResult(event.result, event.quality);
        break;

      case 'error':
        localStorage.removeItem('m004_pending_research');
        this.showToast(event.message || i18n.t('errors.unknown'), 'error');
        this.hideProgressUI();
        break;
    }
  },

  showProgressUI() {
    const progressContainer = document.getElementById('progress-container');
    const resultContainer = document.getElementById('result-container');
    const clarificationContainer = document.getElementById('clarification-container');

    if (progressContainer) progressContainer.classList.remove('hidden');
    if (resultContainer) resultContainer.classList.add('hidden');
    if (clarificationContainer) clarificationContainer.classList.add('hidden');

    // Reset phases
    document.querySelectorAll('.phase-badge').forEach(badge => {
      badge.classList.remove('active', 'completed');
    });
  },

  hideProgressUI() {
    const progressContainer = document.getElementById('progress-container');
    if (progressContainer) progressContainer.classList.add('hidden');
  },

  updateProgress(percent, message) {
    const progressBar = document.getElementById('progress-bar');
    const progressText = document.getElementById('progress-text');
    const progressPercent = document.getElementById('progress-percent');

    if (progressBar) progressBar.style.width = `${percent}%`;
    if (progressText) progressText.textContent = message;
    if (progressPercent) progressPercent.textContent = `${Math.round(percent)}%`;
  },

  updatePhase(phase) {
    document.querySelectorAll('.phase-badge').forEach(badge => {
      badge.classList.remove('active');
    });

    const activeBadge = document.querySelector(`[data-phase="${phase}"]`);
    if (activeBadge) {
      activeBadge.classList.add('active');
    }
  },

  markPhaseComplete(phase) {
    const badge = document.querySelector(`[data-phase="${phase}"]`);
    if (badge) {
      badge.classList.remove('active');
      badge.classList.add('completed');
    }
  },

  showClarificationUI(questions, researchId) {
    this.hideProgressUI();

    const container = document.getElementById('clarification-container');
    const questionsList = document.getElementById('clarification-questions');

    if (!container || !questionsList) return;

    questionsList.innerHTML = questions.map((q, i) => `
      <div class="clarification-question">
        <label for="clarify-${i}">${q.question}</label>
        <input
          type="text"
          id="clarify-${i}"
          class="form-control"
          data-question-id="${q.id || i}"
          placeholder="${q.placeholder || ''}"
        >
      </div>
    `).join('');

    container.classList.remove('hidden');
    container.dataset.researchId = researchId;
  },

  async submitClarification() {
    const container = document.getElementById('clarification-container');
    const researchId = container?.dataset.researchId;

    if (!researchId) return;

    const inputs = document.querySelectorAll('#clarification-questions input');
    const answers = {};

    inputs.forEach(input => {
      const questionId = input.dataset.questionId;
      answers[questionId] = input.value.trim();
    });

    container.classList.add('hidden');
    this.showProgressUI();

    try {
      const response = await api.submitClarification(researchId, answers);
      await this.handleSSEResponse(response);
    } catch (error) {
      console.error('Clarification failed:', error);
      this.showToast(error.message, 'error');
      this.hideProgressUI();
    }
  },

  showResult(result, quality) {
    this.hideProgressUI();

    const container = document.getElementById('result-container');
    if (!container) return;

    // Quality badge с понятным пояснением
    const qualityBadge = document.getElementById('quality-badge');
    if (qualityBadge && quality) {
      const score = quality.compositeScore || 0;
      const pct = Math.round(score * 100);
      let level = 'low';
      let label, description;

      if (i18n.locale === 'ru' || !i18n.locale) {
        if (score >= 0.8) {
          level = 'high';
          label = 'Достоверность';
          description = `${pct}% — Высокая: информация подтверждена несколькими авторитетными источниками. Можно использовать с уверенностью.`;
        } else if (score >= 0.6) {
          level = 'medium';
          label = 'Достоверность';
          description = `${pct}% — Средняя: основные факты проверены, но рекомендуется дополнительная проверка перед принятием решений.`;
        } else {
          level = 'low';
          label = 'Достоверность';
          description = `${pct}% — Требует проверки: информация собрана, но часть фактов не удалось подтвердить. Проверьте важные данные самостоятельно.`;
        }
      } else {
        if (score >= 0.8) {
          level = 'high';
          label = 'Reliability';
          description = `${pct}% — High: information confirmed by multiple authoritative sources. Can be used with confidence.`;
        } else if (score >= 0.6) {
          level = 'medium';
          label = 'Reliability';
          description = `${pct}% — Medium: key facts verified, but additional verification recommended before decision-making.`;
        } else {
          level = 'low';
          label = 'Reliability';
          description = `${pct}% — Needs review: information collected, but some facts could not be confirmed. Verify important data independently.`;
        }
      }

      qualityBadge.className = `quality-badge ${level}`;
      qualityBadge.innerHTML = `<span class="quality-label">${label}: ${pct}%</span>`;
      qualityBadge.title = description;

      // Добавляем пояснение под бейджем
      let qualityExplainer = document.getElementById('quality-explainer');
      if (!qualityExplainer) {
        qualityExplainer = document.createElement('p');
        qualityExplainer.id = 'quality-explainer';
        qualityExplainer.className = 'quality-explainer';
        qualityBadge.parentElement.after(qualityExplainer);
      }
      qualityExplainer.textContent = description;
      qualityExplainer.className = `quality-explainer ${level}`;
    }

    // Report content
    const reportContent = document.getElementById('report-content');
    if (reportContent && result?.report) {
      reportContent.innerHTML = this.parseMarkdown(result.report);
    }

    // Sources — понятное отображение на языке исследования
    const sourcesList = document.getElementById('sources-list');
    if (sourcesList && result?.sources) {
      const lang = (result.metadata && result.metadata.language) || i18n.locale || 'ru';
      const sourcesHeader = document.querySelector('.sources-section h3');
      if (sourcesHeader) {
        sourcesHeader.textContent = lang === 'ru' ? 'Использованные источники' : 'Sources used';
      }

      sourcesList.innerHTML = result.sources.map((source, i) => {
        const authorityScore = source.authorityScore || source.authority || 0;
        const authorityPct = Math.round(authorityScore * 100);
        const authorityClass = this.getAuthorityClass(authorityScore);

        // Человекопонятное описание авторитетности
        let authorityLabel, authorityDesc;
        if (lang === 'ru') {
          if (authorityScore >= 0.8) {
            authorityLabel = 'Высокая надёжность';
            authorityDesc = 'Авторитетный источник (официальный сайт, научное издание)';
          } else if (authorityScore >= 0.5) {
            authorityLabel = 'Средняя надёжность';
            authorityDesc = 'Проверенный источник (отраслевое СМИ, известный портал)';
          } else {
            authorityLabel = 'Требует проверки';
            authorityDesc = 'Источник нуждается в дополнительной верификации';
          }
        } else {
          if (authorityScore >= 0.8) {
            authorityLabel = 'Highly reliable';
            authorityDesc = 'Authoritative source (official site, scientific publication)';
          } else if (authorityScore >= 0.5) {
            authorityLabel = 'Moderately reliable';
            authorityDesc = 'Verified source (industry media, known portal)';
          } else {
            authorityLabel = 'Needs review';
            authorityDesc = 'Source requires additional verification';
          }
        }

        // Определяем домен
        let domain = source.domain || '';
        if (!domain && source.url) {
          try { domain = new URL(source.url).hostname; } catch { domain = ''; }
        }

        // Название источника: если нет title или title = Unknown, показываем домен
        const title = (source.title && source.title !== 'Unknown source' && source.title !== 'unknown')
          ? source.title
          : domain || (lang === 'ru' ? 'Источник без названия' : 'Untitled source');

        const url = source.url && source.url !== '#' && source.url !== 'undefined' ? source.url : null;

        return `
        <a href="${url || '#'}" target="${url ? '_blank' : '_self'}" rel="noopener noreferrer" class="source-item-link" ${!url ? 'onclick="event.preventDefault()"' : ''}>
          <div class="source-item">
            <span class="source-index">[${i + 1}]</span>
            <div class="source-content">
              <div class="source-title-text">${this.escapeHtml(title)}</div>
              ${domain ? `<div class="source-domain">${this.escapeHtml(domain)}</div>` : ''}
              <div class="source-authority-info">
                <span class="source-authority ${authorityClass}" title="${authorityDesc}">
                  ${authorityLabel} (${authorityPct}%)
                </span>
              </div>
            </div>
          </div>
        </a>
      `}).join('');
    }

    // Export buttons — правильная загрузка файлов
    if (this.currentResearchId) {
      const exportMd = document.getElementById('export-md');
      const exportJson = document.getElementById('export-json');

      if (exportMd) {
        exportMd.href = '#';
        exportMd.removeAttribute('download');
        exportMd.onclick = (e) => {
          e.preventDefault();
          this.downloadFile(this.currentResearchId, 'markdown');
        };
      }
      if (exportJson) {
        exportJson.href = '#';
        exportJson.removeAttribute('download');
        exportJson.onclick = (e) => {
          e.preventDefault();
          this.downloadFile(this.currentResearchId, 'json');
        };
      }
    }

    container.classList.remove('hidden');
  },

  async downloadFile(researchId, format) {
    try {
      const response = await fetch(api.getExportUrl(researchId, format));
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Download failed');
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `research-${researchId}.${format === 'markdown' ? 'md' : 'json'}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('[M004] Download failed:', error);
      this.showToast(error.message || i18n.t('errors.network'), 'error');
    }
  },

  getAuthorityClass(score) {
    if (score >= 0.8) return 'high';
    if (score >= 0.5) return 'medium';
    return 'low';
  },

  parseMarkdown(text) {
    // Simple markdown parser
    return text
      // Headers
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      // Bold
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      // Italic
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      // Code blocks
      .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="language-$1">$2</code></pre>')
      // Inline code
      .replace(/`(.+?)`/g, '<code>$1</code>')
      // Links
      .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      // Lists
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
      // Paragraphs
      .replace(/\n\n/g, '</p><p>')
      .replace(/^(.+)$/gm, (match) => {
        if (match.startsWith('<')) return match;
        return `<p>${match}</p>`;
      });
  },

  disableForm(disabled) {
    const form = document.getElementById('research-form');
    if (form) {
      const inputs = form.querySelectorAll('input, textarea, select, button');
      inputs.forEach(input => {
        input.disabled = disabled;
      });
    }
  },

  showToast(message, type = 'info') {
    const container = document.getElementById('toast-container') || this.createToastContainer();

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;

    container.appendChild(toast);

    setTimeout(() => {
      toast.remove();
    }, 5000);
  },

  createToastContainer() {
    const container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
    return container;
  },

  /**
   * Экранирует HTML для безопасного вывода
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
};

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  app.init();
});

window.app = app;
