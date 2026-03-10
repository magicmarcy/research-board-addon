(() => {
  const STORAGE_KEY = 'urlTransformConfig';
  const DEFAULT_CONFIG = {
    enabled: false,
    sourceUrlPattern: '',
    titleIdRegex: '#(\\d+)',
    targetUrlTemplate: '',
    idPlaceholder: '{value}'
  };

  function splitSourceUrlPatterns(raw) {
    return String(raw || '')
      .split(/\r?\n|[;,|]/g)
      .map((item) => item.trim())
      .filter(Boolean);
  }

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
      // Validate regex syntax early for options form feedback.
      new RegExp(c.titleIdRegex);
    } catch (_) {
      return { ok: false, error: 'Regex für den Titelwert ist ungültig.' };
    }
    return { ok: true, config: c };
  }

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

  async function getConfig() {
    if (!globalThis.ext?.storage?.local?.get) return normalizeConfig(DEFAULT_CONFIG);
    const data = await ext.storage.local.get({ [STORAGE_KEY]: DEFAULT_CONFIG });
    return normalizeConfig(data?.[STORAGE_KEY]);
  }

  async function setConfig(config) {
    const check = validateConfig(config);
    if (!check.ok) throw new Error(check.error || 'Ungültige URL-Umschreibung.');
    if (!globalThis.ext?.storage?.local?.set) return check.config;
    await ext.storage.local.set({ [STORAGE_KEY]: check.config });
    return check.config;
  }

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
