(() => {
  /**
   * Shared URL transformation helper.
   *
   * This module encapsulates the optional "rewrite captured URLs based on page title"
   * feature used by the sidebar and background script. It is responsible for:
   * - normalizing and validating persisted configuration
   * - parsing one or more source URL prefixes
   * - extracting a value from the page title through a configurable regex
   * - building a rewritten target URL via a placeholder-based template
   * - reading and writing the feature configuration from extension storage
   *
   * The implementation is intentionally side-effect-light: transformation itself is
   * pure, while storage access is isolated in `getConfig()` and `setConfig()`.
   */
  const STORAGE_KEY = 'urlTransformConfig';
  const DEFAULT_CONFIG = {
    enabled: false,
    sourceUrlPattern: '',
    titleIdRegex: '#(\\d+)',
    targetUrlTemplate: '',
    idPlaceholder: '{value}'
  };

  /**
   * Split a free-form source URL input string into individual prefixes.
   *
   * The options UI accepts line breaks and common delimiter characters so users can
   * define multiple capture prefixes in a compact form.
   *
   * @param {string} raw Raw source URL pattern input.
   * @returns {string[]} Parsed, trimmed source URL prefixes.
   */
  function splitSourceUrlPatterns(raw) {
    return String(raw || '')
      .split(/\r?\n|[;,|]/g)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  /**
   * Return the normalized, de-duplicated source URL prefixes for a config object.
   *
   * @param {object} config Raw or normalized config.
   * @returns {string[]} Unique source URL prefixes.
   */
  function getSourceUrlPatterns(config) {
    const c = normalizeConfig(config);
    const seen = new Set();
    const patterns = [];
    for (const item of splitSourceUrlPatterns(c.sourceUrlPattern)) {
      if (seen.has(item)) continue;
      seen.add(item);
      patterns.push(item);
    }
    return patterns;
  }

  /**
   * Normalize a raw config object into the complete persisted shape used by the addon.
   *
   * @param {object} config Raw config.
   * @returns {{ enabled: boolean, sourceUrlPattern: string, titleIdRegex: string, targetUrlTemplate: string, idPlaceholder: string }} Normalized config.
   */
  function normalizeConfig(config) {
    const c = config && typeof config === 'object' ? config : {};
    return {
      enabled: !!c.enabled,
      sourceUrlPattern: String(c.sourceUrlPattern || '').trim(),
      titleIdRegex: String(c.titleIdRegex || DEFAULT_CONFIG.titleIdRegex).trim() || DEFAULT_CONFIG.titleIdRegex,
      targetUrlTemplate: String(c.targetUrlTemplate || '').trim(),
      idPlaceholder: String(c.idPlaceholder || DEFAULT_CONFIG.idPlaceholder).trim() || DEFAULT_CONFIG.idPlaceholder
    };
  }

  /**
   * Validate URL transformation settings before they are persisted or used.
   *
   * @param {object} config Raw config.
   * @returns {{ ok: true, config: object } | { ok: false, error: string }} Validation result.
   */
  function validateConfig(config) {
    const c = normalizeConfig(config);
    if (!c.enabled) return { ok: true, config: c };

    const sourcePatterns = getSourceUrlPatterns(c);
    if (!sourcePatterns.length) {
      return { ok: false, error: 'Bitte mindestens eine Quell-URL (Prefix) angeben.' };
    }
    if (!c.targetUrlTemplate) {
      return { ok: false, error: 'Bitte eine Ziel-URL-Vorlage angeben.' };
    }
    if (!c.targetUrlTemplate.includes(c.idPlaceholder)) {
      return { ok: false, error: `Die Ziel-URL muss den Platzhalter ${c.idPlaceholder} enthalten.` };
    }
    try {
      // Validate regex syntax early so the options UI can surface configuration errors immediately.
      new RegExp(c.titleIdRegex);
    } catch (_) {
      return { ok: false, error: 'Regex für den Titelwert ist ungültig.' };
    }
    return { ok: true, config: c };
  }

  /**
   * Apply URL transformation rules to a captured URL/title pair.
   *
   * The transformation only runs when:
   * - the feature is enabled
   * - the source URL starts with one of the configured prefixes
   * - the configured title regex extracts a non-empty value
   *
   * @param {string} url Captured source URL.
   * @param {string} title Source page title.
   * @param {object} config Raw or normalized config.
   * @returns {{ transformed: boolean, url: string, extractedValue?: string }} Transformation result.
   */
  function applyToUrl(url, title, config) {
    const c = normalizeConfig(config);
    const sourcePatterns = getSourceUrlPatterns(c);
    const rawUrl = String(url || '');
    const rawTitle = String(title || '');
    if (!c.enabled) return { transformed: false, url: rawUrl };
    if (!rawUrl || !rawTitle) return { transformed: false, url: rawUrl };
    if (!sourcePatterns.length) return { transformed: false, url: rawUrl };
    if (!sourcePatterns.some((pattern) => rawUrl.startsWith(pattern))) return { transformed: false, url: rawUrl };

    let match;
    try {
      // A runtime regex failure should degrade gracefully instead of blocking capture.
      const re = new RegExp(c.titleIdRegex);
      match = re.exec(rawTitle);
    } catch (_) {
      return { transformed: false, url: rawUrl };
    }
    if (!match) return { transformed: false, url: rawUrl };

    const extractedValue = String(match[1] ?? match[0] ?? '').trim();
    if (!extractedValue) return { transformed: false, url: rawUrl };
    const nextUrl = c.targetUrlTemplate.split(c.idPlaceholder).join(encodeURIComponent(extractedValue));
    return { transformed: nextUrl !== rawUrl, url: nextUrl, extractedValue };
  }

  /**
   * Load the persisted URL transformation config from extension storage.
   *
   * @returns {Promise<object>} Normalized config.
   */
  async function getConfig() {
    if (!globalThis.ext?.storage?.local?.get) return normalizeConfig(DEFAULT_CONFIG);
    const data = await ext.storage.local.get({ [STORAGE_KEY]: DEFAULT_CONFIG });
    return normalizeConfig(data?.[STORAGE_KEY]);
  }

  /**
   * Validate and persist the URL transformation config.
   *
   * @param {object} config Raw config.
   * @returns {Promise<object>} Persisted normalized config.
   */
  async function setConfig(config) {
    const check = validateConfig(config);
    if (!check.ok) throw new Error(check.error || 'Ungültige URL-Umschreibung.');
    if (!globalThis.ext?.storage?.local?.set) return check.config;
    await ext.storage.local.set({ [STORAGE_KEY]: check.config });
    return check.config;
  }

  // Expose helpers as a shared global for background, sidebar, and options contexts.
  globalThis.rbUrlTransform = {
    STORAGE_KEY,
    DEFAULT_CONFIG,
    normalizeConfig,
    getSourceUrlPatterns,
    validateConfig,
    applyToUrl,
    getConfig,
    setConfig
  };
})();
