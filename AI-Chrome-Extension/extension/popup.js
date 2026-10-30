(() => {
  'use strict';

  /* ------------------------------------------------------------------------ */
  /* Configuration                                                            */
  /* ------------------------------------------------------------------------ */

  // If you change the backend port, update this URL and host_permissions in
  // manifest.json as well.
  const TEXT_API_URL = 'http://127.0.0.1:3000/api/generate';
  const IMAGE_API_URL = 'http://127.0.0.1:3000/api/image';
  const MAX_TEXT_PROMPT_LENGTH = 4000;
  const MAX_IMAGE_PROMPT_LENGTH = 1000; // keep in sync with the backend
  const REQUEST_TIMEOUT_MS = 70_000;
  const MAX_ERROR_LENGTH = 300;

  // Response templates. Keys must stay in sync with TEMPLATE_INSTRUCTIONS in
  // backend/server.js.
  const TEMPLATES = [
    { id: 'default', label: 'Default' },
    { id: 'detailed', label: 'Detailed' },
    { id: 'concise', label: 'Concise' },
    { id: 'eli5', label: 'Explain simply (ELI5)' },
    { id: 'technical', label: 'Technical' },
    { id: 'creative', label: 'Creative' },
    { id: 'explain', label: 'Deep explanation' },
    { id: 'summarize', label: 'Bullet summary' },
  ];

  // Response-speed presets ("slow / medium / high"). Keys must stay in sync
  // with RESPONSE_MODE_INSTRUCTIONS in backend/server.js.
  const RESPONSE_MODES = [
    { id: 'slow', label: 'Slow · most detailed' },
    { id: 'medium', label: 'Medium · balanced' },
    { id: 'fast', label: 'Fast · brief answer' },
  ];

  /* ------------------------------------------------------------------------ */
  /* Preferences (persisted locally)                                          */
  /* ------------------------------------------------------------------------ */

  const PREFS_KEY = 'gemini-assistant-preferences';

  function loadPrefs() {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return typeof parsed === 'object' && parsed ? parsed : {};
    } catch {
      return {};
    }
  }

  const prefs = {
    theme: 'system', // "light" | "dark" | "system"
    template: 'default',
    responseMode: 'medium',
    appMode: 'text', // "text" | "image"
    ...loadPrefs(),
  };

  function savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // Storage may be unavailable; preferences simply are not persisted.
    }
  }

  /* ------------------------------------------------------------------------ */
  /* DOM references                                                           */
  /* ------------------------------------------------------------------------ */

  const elements = {
    app: document.querySelector('#app'),
    themeBtn: document.querySelector('#theme-btn'),
    themeIconSun: document.querySelector('#theme-icon-sun'),
    themeIconMoon: document.querySelector('#theme-icon-moon'),
    form: document.querySelector('#prompt-form'),
    modeTextBtn: document.querySelector('#mode-text'),
    modeImageBtn: document.querySelector('#mode-image'),
    promptLabel: document.querySelector('#prompt-label'),
    prompt: document.querySelector('#prompt'),
    charCount: document.querySelector('#char-count'),
    templateSelect: document.querySelector('#template-select'),
    responseSelect: document.querySelector('#response-select'),
    generateBtn: document.querySelector('#generate-btn'),
    generateLabel: document.querySelector('#generate-label'),
    loading: document.querySelector('#loading'),
    loadingText: document.querySelector('#loading-text'),    error: document.querySelector('#error'),
    errorMessage: document.querySelector('#error-message'),
    dismissError: document.querySelector('#dismiss-error'),
    outputSection: document.querySelector('#output-section'),
    outputTitleText: document.querySelector('#output-title-text'),
    output: document.querySelector('#output'),
    outputImageWrap: document.querySelector('#output-image-wrap'),
    outputImage: document.querySelector('#output-image'),
    copyBtn: document.querySelector('#copy-btn'),
    downloadBtn: document.querySelector('#download-btn'),
  };

  let isGenerating = false;
  let copyResetTimer = null;
  let currentImageUrl = null;

  /* ------------------------------------------------------------------------ */
  /* Theme                                                                    */
  /* ------------------------------------------------------------------------ */

  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');

  function applyTheme() {
    if (prefs.theme === 'light' || prefs.theme === 'dark') {
      document.documentElement.dataset.theme = prefs.theme;
    } else {
      delete document.documentElement.dataset.theme; // "system" follows the OS
    }

    const currentIsDark =
      prefs.theme === 'dark' || (prefs.theme === 'system' && prefersDark.matches);
    elements.themeIconSun.hidden = currentIsDark;
    elements.themeIconMoon.hidden = !currentIsDark;

    const next = prefs.theme === 'light' ? 'dark' : 'light';
    elements.themeBtn.title = `Theme: ${prefs.theme} (click for ${next})`;
  }

  elements.themeBtn.addEventListener('click', () => {
    // Cycle: light -> dark -> system -> light
    prefs.theme =
      prefs.theme === 'light' ? 'dark' : prefs.theme === 'dark' ? 'system' : 'light';
    savePrefs();
    applyTheme();
  });

  prefersDark.addEventListener('change', () => {
    if (prefs.theme === 'system') applyTheme();
  });

  /* ------------------------------------------------------------------------ */
  /* Selects (template + response speed)                                      */
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
  fillSelect(elements.responseSelect, RESPONSE_MODES);

  function syncSelect(select, value, fallback) {
    const exists = [...select.options].some((option) => option.value === value);
    select.value = exists ? value : fallback;
  }

  elements.templateSelect.addEventListener('change', () => {
    prefs.template = elements.templateSelect.value;
    savePrefs();
  });

  elements.responseSelect.addEventListener('change', () => {
    prefs.responseMode = elements.responseSelect.value;
    savePrefs();
  });

  /* ------------------------------------------------------------------------ */
  /* Text / image mode switching                                              */
  /* ------------------------------------------------------------------------ */

  const isImageMode = () => prefs.appMode === 'image';

  function maxPromptLength() {
    return isImageMode() ? MAX_IMAGE_PROMPT_LENGTH : MAX_TEXT_PROMPT_LENGTH;
  }

  function setAppMode(mode) {
    prefs.appMode = mode === 'image' ? 'image' : 'text';
    savePrefs();

    const imageMode = isImageMode();
    elements.app.classList.toggle('is-image', imageMode);
    elements.modeTextBtn.setAttribute('aria-selected', String(!imageMode));
    elements.modeImageBtn.setAttribute('aria-selected', String(imageMode));

    elements.promptLabel.textContent = imageMode ? 'Image prompt' : 'Your prompt';
    elements.prompt.placeholder = imageMode
      ? 'Describe the image, e.g. a watercolor fox in a misty forest…'
      : "e.g. Explain quantum computing like I'm five…";
    elements.prompt.setAttribute('maxlength', String(maxPromptLength()));

    elements.generateLabel.textContent = imageMode ? 'Generate image' : 'Generate';
    elements.loadingText.textContent = imageMode
      ? 'Gemini is painting…'
      : 'Gemini is thinking…';
    elements.outputTitleText.textContent = imageMode ? 'Image' : 'Response';

    elements.output.hidden = imageMode;
    elements.outputImageWrap.hidden = true;
    updateCharCount();
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
    const length = elements.prompt.value.length;
    const max = maxPromptLength();
    elements.charCount.textContent = `${length.toLocaleString('en-US')} / ${max.toLocaleString('en-US')}`;
    elements.charCount.classList.toggle('near-limit', length >= max * 0.9);
    if (length > max) {
      elements.prompt.value = elements.prompt.value.slice(0, max);
      elements.charCount.classList.add('near-limit');
    }
  }

  function setLoading(isLoading) {
    isGenerating = isLoading;
    elements.generateBtn.disabled = isLoading;
    elements.generateLabel.textContent = isLoading
      ? 'Generating…'
      : isImageMode()
        ? 'Generate image'
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
    currentImageUrl = null;
    elements.copyBtn.textContent = 'Copy';
    elements.copyBtn.classList.remove('copied');
  }

  function showOutput(text) {
    elements.output.textContent = text;
    elements.outputSection.hidden = false;
    elements.copyBtn.textContent = 'Copy';
    elements.copyBtn.classList.remove('copied');
  }

  function showImage(dataUrl) {
    currentImageUrl = dataUrl;
    elements.outputImage.src = dataUrl;
    elements.outputImageWrap.hidden = false;
    elements.outputSection.hidden = false;
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
  /* Events                                                                   */
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
  /* Quick actions (Explain / Summarize / Rewrite)                            */
  /* ------------------------------------------------------------------------ */

  const QUICK_ACTIONS = {
    explain: (text) =>
      `Explain the following step by step, in clear simple language. Start with a one-paragraph summary, then break it down:\n\n${text}`,
    summarize: (text) =>
      `Summarize the following into the key points as a short bulleted list:\n\n${text}`,
    rewrite: (text) =>
      `Rewrite the following text so it is clear, correct and professional, and return only the rewritten version:\n\n${text}`,
  };

  for (const chip of document.querySelectorAll('.chip')) {
    chip.addEventListener('click', () => {
      if (isGenerating) return;

      const text = elements.prompt.value.trim();
      if (!text || text.length > maxPromptLength()) {
        clearError();
        showError('Enter some text first, then pick a quick action.');
        elements.prompt.focus();
        return;
      }

      const action = QUICK_ACTIONS[chip.dataset.action];
      if (!action) return;

      if (isImageMode()) setAppMode('text');
      elements.prompt.value = action(text);
      updateCharCount();
      generate(elements.prompt.value.trim());
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Copy response                                                            */
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
    elements.copyBtn.textContent = 'Copied';
    elements.copyBtn.classList.add('copied');
    copyResetTimer = setTimeout(() => {
      elements.copyBtn.textContent = 'Copy';
      elements.copyBtn.classList.remove('copied');
    }, 1600);
  }

  elements.copyBtn.addEventListener('click', async () => {
    if (isImageMode()) {
      // Copying images needs clipboard.write with real blobs; the button is
      // hidden in image mode anyway, so there is nothing to do here.
      return;
    }

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
  /* Download response                                                        */
  /* ------------------------------------------------------------------------ */

  function triggerDownload(anchor) {
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }

  elements.downloadBtn.addEventListener('click', () => {
    try {
      if (isImageMode()) {
        if (!currentImageUrl) {
          showError('Generate an image first, then download it.');
          return;
        }
        const link = document.createElement('a');
        link.href = currentImageUrl;
        link.download = `gemini-image-${Date.now()}.png`;
        triggerDownload(link);
        return;
      }

      const text = elements.output.textContent;
      if (!text) {
        showError('Generate a response first, then download it.');
        return;
      }

      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `gemini-response-${Date.now()}.txt`;
      triggerDownload(link);
      setTimeout(() => URL.revokeObjectURL(url), 5_000);
    } catch (error) {
      console.error('[popup] Download failed:', error);
      showError('Could not download the response.');
    }
  });

  /* ------------------------------------------------------------------------ */
  /* Init                                                                     */
  /* ------------------------------------------------------------------------ */

  syncSelect(elements.templateSelect, prefs.template, 'default');
  syncSelect(elements.responseSelect, prefs.responseMode, 'medium');

  setAppMode(prefs.appMode);
  applyTheme();
  updateCharCount();
})();
