(() => {
  'use strict';

  /* ------------------------------------------------------------------------ */
  /* Configuration                                                            */
  /* ------------------------------------------------------------------------ */

  // If you change the backend port, update these URLs and host_permissions in
  // manifest.json as well.
  const TEXT_API_URL = 'http://127.0.0.1:3000/api/generate';
  const IMAGE_API_URL = 'http://127.0.0.1:3000/api/generate-image';
  const MAX_TEXT_PROMPT_LENGTH = 4000;
  const MAX_IMAGE_PROMPT_LENGTH = 1000; // keep in sync with the backend
  const REQUEST_TIMEOUT_MS = 70_000;
  const MAX_ERROR_LENGTH = 300;
  const PREFS_KEY = 'gemini-field-notes.prefs.v1';

  // Keys must stay in sync with PROMPT_TEMPLATES in backend/server.js.
  const TEMPLATES = [
    { id: 'general', label: 'General', note: 'direct & useful' },
    { id: 'explain', label: 'Explain', note: 'steps + takeaway' },
    { id: 'summarize', label: 'Summarize', note: 'key points only' },
    { id: 'code', label: 'Code', note: 'runnable + notes' },
    { id: 'creative', label: 'Creative', note: 'vivid voice' },
  ];

  // Keys must stay in sync with RESPONSE_MODES in backend/server.js.
  const DEPTHS = [
    { id: 'quick', label: 'Quick', note: 'effort \u00b7 low' },
    { id: 'balanced', label: 'Balanced', note: 'effort \u00b7 medium' },
    { id: 'detailed', label: 'Deep', note: 'effort \u00b7 high' },
  ];

  /* ------------------------------------------------------------------------ */
  /* Preferences                                                              */
  /* ------------------------------------------------------------------------ */

  function loadPrefs() {
    let saved = {};

    try {
      const raw = localStorage.getItem(PREFS_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object') saved = parsed;
    } catch {
      // Storage may be unavailable; defaults still make the popup usable.
    }

    return {
      theme: ['system', 'light', 'dark'].includes(saved.theme) ? saved.theme : 'system',
      template: TEMPLATES.some((item) => item.id === saved.template)
        ? saved.template
        : 'general',
      responseMode: DEPTHS.some((item) => item.id === saved.responseMode)
        ? saved.responseMode
        : 'balanced',
      appMode: saved.appMode === 'image' ? 'image' : 'text',
    };
  }

  const prefs = loadPrefs();

  function savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // Preferences simply are not persisted if storage is unavailable.
    }
  }

  /* ------------------------------------------------------------------------ */
  /* DOM references                                                           */
  /* ------------------------------------------------------------------------ */

  const elements = {
    app: document.querySelector('#app'),
    themeBtn: document.querySelector('#theme-btn'),
    themeLabel: document.querySelector('#theme-label'),
    themeIconSun: document.querySelector('#theme-icon-sun'),
    themeIconMoon: document.querySelector('#theme-icon-moon'),
    themeIconSystem: document.querySelector('#theme-icon-system'),
    form: document.querySelector('#prompt-form'),
    modeTextBtn: document.querySelector('#mode-text'),
    modeImageBtn: document.querySelector('#mode-image'),
    modeNote: document.querySelector('#mode-note'),
    promptLabel: document.querySelector('#prompt-label'),
    promptLabelText: document.querySelector('#prompt-label-text'),
    prompt: document.querySelector('#prompt'),
    charCount: document.querySelector('#char-count'),
    templateSelect: document.querySelector('#template-select'),
    templateNote: document.querySelector('#template-note'),
    depthNote: document.querySelector('#depth-note'),
    imageNote: document.querySelector('#image-note'),
    generateBtn: document.querySelector('#generate-btn'),
    generateLabel: document.querySelector('#generate-label'),
    loading: document.querySelector('#loading'),
    loadingText: document.querySelector('#loading-text'),
    error: document.querySelector('#error'),
    errorMessage: document.querySelector('#error-message'),
    dismissError: document.querySelector('#dismiss-error'),
    outputSection: document.querySelector('#output-section'),
    outputTitleText: document.querySelector('#output-title-text'),
    outputStatus: document.querySelector('#output-status'),
    output: document.querySelector('#output'),
    outputImageWrap: document.querySelector('#output-image-wrap'),
    outputImage: document.querySelector('#output-image'),
    copyBtn: document.querySelector('#copy-btn'),
    copyLabel: document.querySelector('#copy-label'),
    downloadBtn: document.querySelector('#download-btn'),
  };

  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');

  let isGenerating = false;
  let copyResetTimer = null;
  let currentImageUrl = null;

  /* ------------------------------------------------------------------------ */
  /* Theme                                                                    */
  /* ------------------------------------------------------------------------ */

  function currentTheme() {
    if (prefs.theme === 'system') {
      return prefersDark.matches ? 'dark' : 'light';
    }
    return prefs.theme;
  }

  function applyTheme() {
    const theme = currentTheme();
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;

    elements.themeIconSun.hidden = prefs.theme !== 'light';
    elements.themeIconMoon.hidden = prefs.theme !== 'dark';
    elements.themeIconSystem.hidden = prefs.theme !== 'system';
    elements.themeLabel.textContent =
      prefs.theme === 'system' ? 'SYS' : prefs.theme === 'dark' ? 'DARK' : 'LIGHT';

    const label = `Theme: ${prefs.theme}. Click to change.`;
    elements.themeBtn.title = label;
    elements.themeBtn.setAttribute('aria-label', label);
  }

  elements.themeBtn.addEventListener('click', () => {
    prefs.theme =
      prefs.theme === 'system' ? 'light' : prefs.theme === 'light' ? 'dark' : 'system';
    savePrefs();
    applyTheme();
  });

  prefersDark.addEventListener('change', () => {
    if (prefs.theme === 'system') applyTheme();
  });

  /* ------------------------------------------------------------------------ */
  /* Selects + depth cards                                                    */
  /* ------------------------------------------------------------------------ */

  function fillSelect(select, options) {
    for (const option of options) {
      const element = document.createElement('option');
      element.value = option.id;
      element.textContent = option.label;
      select.appendChild(element);
    }
  }

  fillSelect(elements.templateSelect, TEMPLATES);

  function updateTemplateNote() {
    const selected = TEMPLATES.find((item) => item.id === prefs.template) ?? TEMPLATES[0];
    elements.templateNote.textContent = selected.note;
    elements.templateSelect.value = selected.id;
  }

  function updateDepthNote() {
    const selected = DEPTHS.find((item) => item.id === prefs.responseMode) ?? DEPTHS[1];
    elements.depthNote.textContent = selected.note;
  }

  function setDepth(value, persist = true) {
    const selected = DEPTHS.find((item) => item.id === value) ?? DEPTHS[1];
    prefs.responseMode = selected.id;

    for (const input of document.querySelectorAll('input[name="depth"]')) {
      input.checked = input.value === selected.id;
    }

    updateDepthNote();
    if (persist) savePrefs();
  }

  elements.templateSelect.addEventListener('change', () => {
    prefs.template = elements.templateSelect.value;
    updateTemplateNote();
    savePrefs();
  });

  for (const input of document.querySelectorAll('input[name="depth"]')) {
    input.addEventListener('change', () => {
      if (input.checked) setDepth(input.value);
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Text / image mode                                                        */
  /* ------------------------------------------------------------------------ */

  const isImageMode = () => prefs.appMode === 'image';
  const maxPromptLength = () =>
    isImageMode() ? MAX_IMAGE_PROMPT_LENGTH : MAX_TEXT_PROMPT_LENGTH;

  function setAppMode(mode, persist = true) {
    prefs.appMode = mode === 'image' ? 'image' : 'text';
    const imageMode = isImageMode();

    elements.app.classList.toggle('is-image', imageMode);
    elements.modeTextBtn.setAttribute('aria-pressed', String(!imageMode));
    elements.modeImageBtn.setAttribute('aria-pressed', String(imageMode));
    elements.modeNote.textContent = imageMode ? 'pictures' : 'words';

    elements.promptLabelText.textContent = imageMode ? 'Image prompt' : 'Prompt';
    elements.prompt.placeholder = imageMode
      ? 'e.g. A tiny observatory on a cliff, risograph print, two colours, night sky.'
      : "e.g. Explain why the sky turns red at sunset, like I'm curious but busy.";
    elements.prompt.setAttribute('maxlength', String(maxPromptLength()));

    elements.generateLabel.textContent = imageMode ? 'Make image' : 'Generate';
    elements.loadingText.textContent = imageMode ? 'Gemini is painting' : 'Gemini is thinking';
    elements.outputTitleText.textContent = imageMode ? 'Image' : 'Result';
    elements.imageNote.hidden = !imageMode;

    elements.copyLabel.textContent = 'Copy';
    elements.copyBtn.classList.remove('copied');
    resetOutput();
    updateCharCount();

    if (persist) savePrefs();
  }

  elements.modeTextBtn.addEventListener('click', () => {
    if (!isGenerating && prefs.appMode !== 'text') setAppMode('text');
  });

  elements.modeImageBtn.addEventListener('click', () => {
    if (!isGenerating && prefs.appMode !== 'image') setAppMode('image');
  });

  /* ------------------------------------------------------------------------ */
  /* UI helpers                                                               */
  /* ------------------------------------------------------------------------ */

  function updateCharCount() {
    const max = maxPromptLength();

    if (elements.prompt.value.length > max) {
      elements.prompt.value = elements.prompt.value.slice(0, max);
    }

    const length = elements.prompt.value.length;
    elements.charCount.textContent = `${length.toLocaleString('en-US')} / ${max.toLocaleString('en-US')}`;
    elements.charCount.classList.toggle('near-limit', length >= max * 0.9);
  }

  function setLoading(isLoading) {
    isGenerating = isLoading;
    elements.generateBtn.disabled = isLoading;
    elements.modeTextBtn.disabled = isLoading;
    elements.modeImageBtn.disabled = isLoading;

    elements.generateLabel.textContent = isLoading
      ? isImageMode()
        ? 'Painting\u2026'
        : 'Thinking\u2026'
      : isImageMode()
        ? 'Make image'
        : 'Generate';

    elements.loading.hidden = !isLoading;
    elements.form.setAttribute('aria-busy', String(isLoading));
  }

  function showError(message) {
    elements.errorMessage.textContent = message;
    elements.error.hidden = false;
  }

  function clearError() {
    elements.error.hidden = true;
    elements.errorMessage.textContent = '';
  }

  function resetOutput() {
    elements.outputSection.hidden = true;
    elements.output.textContent = '';
    elements.outputImageWrap.hidden = true;
    elements.outputImage.removeAttribute('src');
    elements.outputStatus.textContent = 'received';
    currentImageUrl = null;

    clearTimeout(copyResetTimer);
    elements.copyLabel.textContent = 'Copy';
    elements.copyBtn.classList.remove('copied');
  }

  function revealResult() {
    elements.outputSection.hidden = false;
    elements.outputSection.scrollIntoView({ block: 'nearest' });
  }

  function showOutput(text) {
    elements.output.textContent = text;
    elements.output.hidden = false;
    elements.outputImageWrap.hidden = true;
    elements.outputStatus.textContent = 'received';
    revealResult();
  }

  function showImage(dataUrl) {
    currentImageUrl = dataUrl;
    elements.outputImage.src = dataUrl;
    elements.output.hidden = true;
    elements.outputImageWrap.hidden = false;
    elements.outputStatus.textContent = 'rendered';
    revealResult();
  }

  function getResponseError(data, status) {
    const message = data?.error?.message;

    if (
      typeof message === 'string' &&
      message.trim() &&
      message.length <= MAX_ERROR_LENGTH
    ) {
      return message.trim();
    }

    if (status === 429) {
      return 'Too many requests. Please wait a moment and try again.';
    }

    if (status >= 500) {
      return 'The server could not complete the request. Please try again.';
    }

    return `The request failed (HTTP ${status}). Please try again.`;
  }

  async function readJson(response) {
    const raw = await response.text();
    if (!raw) return null;

    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Generation                                                               */
  /* ------------------------------------------------------------------------ */

  async function generate(promptText) {
    const imageMode = isImageMode();
    clearError();
    resetOutput();
    setLoading(true);

    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(imageMode ? IMAGE_API_URL : TEXT_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(
          imageMode
            ? { prompt: promptText }
            : {
                prompt: promptText,
                template: prefs.template,
                responseMode: prefs.responseMode,
              },
        ),
        signal: controller.signal,
      });

      const data = await readJson(response);

      if (!response.ok) {
        showError(getResponseError(data, response.status));
        return;
      }

      if (imageMode) {
        const image = data?.image;
        if (typeof image !== 'string' || !image.startsWith('data:image/')) {
          showError("The server didn't return an image. Please try again.");
          return;
        }
        showImage(image);
      } else {
        const answer = data?.response;
        if (typeof answer !== 'string' || !answer.trim()) {
          showError('The server returned an unexpected response. Please try again.');
          return;
        }
        showOutput(answer.trim());
      }
    } catch (error) {
      if (error?.name === 'AbortError') {
        showError(
          timedOut
            ? 'The request timed out. Please try again.'
            : 'The request was cancelled. Please try again.',
        );
      } else if (error instanceof TypeError) {
        showError(
          'Could not reach the backend. Make sure it is running at http://127.0.0.1:3000.',
        );
      } else {
        console.error('[popup] Unexpected error:', error);
        showError('Something went wrong. Please try again.');
      }
    } finally {
      clearTimeout(timeoutId);
      setLoading(false);
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Submit + prompt events                                                   */
  /* ------------------------------------------------------------------------ */

  elements.form.addEventListener('submit', (event) => {
    event.preventDefault();

    if (isGenerating) return;

    const promptText = elements.prompt.value.trim();
    const max = maxPromptLength();

    if (!promptText) {
      clearError();
      showError(
        isImageMode()
          ? 'Describe the image you want before generating.'
          : 'Please enter a prompt before generating.',
      );
      elements.prompt.focus();
      return;
    }

    if (promptText.length > max) {
      showError(`The prompt must be ${max.toLocaleString('en-US')} characters or fewer.`);
      elements.prompt.focus();
      return;
    }

    generate(promptText);
  });

  elements.prompt.addEventListener('input', updateCharCount);

  elements.prompt.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      elements.form.requestSubmit();
    }
  });

  elements.dismissError.addEventListener('click', () => {
    clearError();
    elements.prompt.focus();
  });

  /* ------------------------------------------------------------------------ */
  /* Quick actions                                                            */
  /* ------------------------------------------------------------------------ */

  const QUICK_ACTIONS = {
    explain: {
      template: 'explain',
      build: (text) =>
        `Explain the following clearly, step by step. Start with a one-paragraph summary, then break it down, and finish with a one-sentence takeaway:\n\n${text}`,
    },
    summarize: {
      template: 'summarize',
      build: (text) =>
        `Summarize the following into the key points. Lead with the main takeaway, then list the supporting points in order of importance:\n\n${text}`,
    },
    rewrite: {
      template: null,
      build: (text) =>
        `Rewrite the following so it is clear, correct, and natural, and return only the rewritten version:\n\n${text}`,
    },
  };

  for (const chip of document.querySelectorAll('.stamp')) {
    chip.addEventListener('click', () => {
      if (isGenerating) return;

      const text = elements.prompt.value.trim();
      if (!text) {
        clearError();
        showError('Write something first, then pick a quick action.');
        elements.prompt.focus();
        return;
      }

      if (isImageMode()) setAppMode('text');

      const action = QUICK_ACTIONS[chip.dataset.action];
      if (!action) return;

      if (action.template && prefs.template !== action.template) {
        prefs.template = action.template;
        updateTemplateNote();
        savePrefs();
      }

      const nextPrompt = action.build(text);
      if (nextPrompt.length > MAX_TEXT_PROMPT_LENGTH) {
        showError('That text is too long for a quick action. Trim it and try again.');
        return;
      }

      elements.prompt.value = nextPrompt;
      updateCharCount();
      generate(nextPrompt);
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Copy                                                                     */
  /* ------------------------------------------------------------------------ */

  function fallbackCopy(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();

    const copied = document.execCommand('copy');
    textarea.remove();

    if (!copied) {
      throw new Error('Clipboard copy failed');
    }
  }

  function showCopiedState() {
    clearTimeout(copyResetTimer);
    elements.copyLabel.textContent = 'Copied';
    elements.copyBtn.classList.add('copied');
    copyResetTimer = setTimeout(() => {
      elements.copyLabel.textContent = 'Copy';
      elements.copyBtn.classList.remove('copied');
    }, 1600);
  }

  elements.copyBtn.addEventListener('click', async () => {
    if (isImageMode()) return;

    const text = elements.output.textContent;
    if (!text) return;

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        fallbackCopy(text);
      }
      showCopiedState();
    } catch {
      try {
        fallbackCopy(text);
        showCopiedState();
      } catch {
        showError('Could not copy the response to the clipboard.');
      }
    }
  });

  /* ------------------------------------------------------------------------ */
  /* Download                                                                 */
  /* ------------------------------------------------------------------------ */

  function triggerDownload(url, filename, revoke) {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();

    if (revoke) {
      setTimeout(() => URL.revokeObjectURL(url), 5_000);
    }
  }

  function dataUrlToBlob(dataUrl) {
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
    if (!match) throw new Error('Invalid image data URL');

    const mime = match[1] || 'image/png';
    const payload = match[3];
    const bytes = match[2]
      ? Uint8Array.from(atob(payload), (character) => character.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(payload));

    return new Blob([bytes], { type: mime });
  }

  elements.downloadBtn.addEventListener('click', () => {
    try {
      if (isImageMode()) {
        if (!currentImageUrl) {
          showError('Generate an image first, then save it.');
          return;
        }

        const blob = dataUrlToBlob(currentImageUrl);
        const extension = blob.type.includes('jpeg')
          ? 'jpg'
          : blob.type.includes('webp')
            ? 'webp'
            : 'png';
        const url = URL.createObjectURL(blob);
        triggerDownload(url, `gemini-image-${Date.now()}.${extension}`, true);
        return;
      }

      const text = elements.output.textContent;
      if (!text) {
        showError('Generate a response first, then save it.');
        return;
      }

      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      triggerDownload(url, `gemini-response-${Date.now()}.txt`, true);
    } catch (error) {
      console.error('[popup] Download failed:', error);
      showError('Could not download the result.');
    }
  });

  /* ------------------------------------------------------------------------ */
  /* Init                                                                     */
  /* ------------------------------------------------------------------------ */

  updateTemplateNote();
  setDepth(prefs.responseMode, false);
  setAppMode(prefs.appMode, false);
  applyTheme();
  updateCharCount();
})();
