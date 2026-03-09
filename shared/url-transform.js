(() => {
  const STORAGE_KEY = 'urlTransformConfig';
  const DEFAULT_CONFIG = {
    enabled: false,
    sourceUrlPattern: '',
    titleIdRegex: '#(\\d+)',
    targetUrlTemplate: '',
    idPlaceholder: '{value}'
  };

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

    if (!c.sourceUrlPattern) {
      return { ok: false, error: 'Bitte eine Quell-URL (Prefix) angeben.' };
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
    const rawUrl = String(url || '');
    const rawTitle = String(title || '');
    if (!c.enabled) return { transformed: false, url: rawUrl };
    if (!rawUrl || !rawTitle) return { transformed: false, url: rawUrl };
    if (!c.sourceUrlPattern || !rawUrl.startsWith(c.sourceUrlPattern)) return { transformed: false, url: rawUrl };

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
    validateConfig,
    applyToUrl,
    getConfig,
    setConfig
  };
})();
