// background.js - Service Worker for Veeva Vault RIM Config Documenter
// NOTE: All Veeva Vault API interactions are strictly READ-ONLY (GET / VQL SELECT queries).

const DEFAULT_SETTINGS = {
  isRecording: true,
  autoGoToPrefix: true,
  passClickThrough: true,
  highlightOnScreenshot: false,
  includeApiNames: true,
  mode1Style: 'blank_line', // 'blank_line' (\n\n) or 'sub_item' (\n   > ) or 'new_block'
  showFloatingHud: true,
  appendComponentsToDoc: true,
  componentsFormat: 'text',
  enableObjectSchemaTools: false
};

/**
 * Draws a clean, flat enterprise Veeva Vault-style icon onto OffscreenCanvas
 * at 16x16, 32x32, 48x48, and 128x128 for the Chrome/Edge extension toolbar.
 */
function updateToolbarAppIcon(isRecording = true) {
  if (typeof OffscreenCanvas === 'undefined' || !chrome.action || !chrome.action.setIcon) return;

  try {
    const sizes = [16, 32, 48, 128];
    const imageDataMap = {};

    for (const size of sizes) {
      const canvas = new OffscreenCanvas(size, size);
      const ctx = canvas.getContext('2d');
      const s = size / 128;

      ctx.save();
      ctx.scale(s, s);

      // 1. Veeva Deep Navy Base (#14233C) with Veeva Orange Top Accent (#F7941D)
      drawRoundRect(ctx, 6, 6, 116, 116, 16);
      ctx.fillStyle = '#14233C';
      ctx.fill();

      // Top Orange Bar
      ctx.fillStyle = '#F7941D';
      drawRoundRect(ctx, 6, 6, 116, 22, 16);
      ctx.fill();
      ctx.fillRect(6, 18, 116, 10);

      // 2. White Config Document Sheet with Orange Section Rule
      ctx.fillStyle = '#FFFFFF';
      drawRoundRect(ctx, 26, 22, 72, 86, 4);
      ctx.fill();
      ctx.fillStyle = '#F7941D';
      ctx.fillRect(26, 36, 72, 4);

      // 3. Veeva Orange "V" mark inside document
      ctx.beginPath();
      ctx.moveTo(38, 48);
      ctx.lineTo(48, 70);
      ctx.lineTo(58, 48);
      ctx.lineWidth = 7;
      ctx.strokeStyle = '#F7941D';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();

      // 4. Clean Enterprise Config Lines (Veeva Royal Blue & Navy)
      ctx.fillStyle = '#1959A8';
      ctx.fillRect(66, 48, 22, 6);
      ctx.fillStyle = '#7A869A';
      ctx.fillRect(66, 60, 16, 6);

      ctx.fillStyle = '#14233C';
      ctx.fillRect(38, 80, 50, 6);
      ctx.fillStyle = '#7A869A';
      ctx.fillRect(38, 92, 36, 6);

      // 5. Status Indicator Dot (Bottom-Right)
      ctx.beginPath();
      ctx.arc(102, 102, 14, 0, Math.PI * 2);
      ctx.fillStyle = isRecording ? '#1959A8' : '#7A869A';
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#14233C';
      ctx.stroke();

      ctx.restore();
      imageDataMap[size] = ctx.getImageData(0, 0, size, size);
    }

    chrome.action.setIcon({ imageData: imageDataMap });
  } catch (e) {
    console.warn('Toolbar icon render notice:', e);
  }
}

function drawRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Injects content.css and content.js into already-open tabs so the user does not
 * need to manually reload their Veeva Vault tab after installing/reloading the extension.
 */
async function ensureContentScriptsInOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    for (const tab of tabs) {
      if (!tab.id) continue;
      try {
        await chrome.scripting.insertCSS({
          target: { tabId: tab.id, allFrames: true },
          files: ['content.css']
        });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ['content.js']
        });
      } catch (e) {
        // Ignore restricted tabs
      }
    }
  } catch (err) {
    console.warn('Auto-inject notice:', err);
  }
}

// Always enforce docked Side Panel (never a floating popup window)
function enforceDockedSidePanel() {
  if (chrome.action && chrome.action.setPopup) {
    try {
      chrome.action.setPopup({ popup: '' });
    } catch (e) {}
  }
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
}

enforceDockedSidePanel();

// Initialize extension state on install & startup
chrome.runtime.onStartup.addListener(async () => {
  enforceDockedSidePanel();
  const data = await chrome.storage.local.get(['settings']);
  const isRec = data.settings ? data.settings.isRecording !== false : true;
  updateToolbarAppIcon(isRec);
  await ensureContentScriptsInOpenTabs();
});

chrome.runtime.onInstalled.addListener(async () => {
  enforceDockedSidePanel();

  const data = await chrome.storage.local.get([
    'settings',
    'docSteps',
    'affectedComponents',
    'allComponents',
    'vaultSession',
    'docMeta'
  ]);
  const settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  await chrome.storage.local.set({ settings });
  updateToolbarAppIcon(settings.isRecording);

  if (!data.docSteps) {
    await chrome.storage.local.set({ docSteps: [] });
  }
  if (!data.affectedComponents) {
    await chrome.storage.local.set({ affectedComponents: [] });
  }
  if (!data.allComponents) {
    await chrome.storage.local.set({
      allComponents: Array.isArray(data.affectedComponents) ? [...data.affectedComponents] : []
    });
  }
  if (!data.docMeta) {
    await chrome.storage.local.set({
      docMeta: {
        title: 'Veeva Vault RIM Configuration Steps',
        ticketId: '',
        environment: 'Sandbox',
        sessionStartTime: new Date().toISOString()
      }
    });
  }
  if (!data.vaultSession) {
    await chrome.storage.local.set({
      vaultSession: {
        connected: false,
        vaultDns: '',
        ssid: '',
        userName: '',
        userId: '',
        vaultName: '',
        lastVerified: null
      }
    });
  }

  await ensureContentScriptsInOpenTabs();
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab && tab.url && /^https?:\/\//i.test(tab.url)) {
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id, allFrames: true },
        files: ['content.css']
      });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['content.js']
      });
    }
  } catch (e) {}
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings && changes.settings.newValue) {
    updateToolbarAppIcon(changes.settings.newValue.isRecording !== false);
  }
});

// Listen for messages from content scripts and sidepanel
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  if (message.type === 'RECORD_ACTION') {
    handleRecordAction(message.payload, sender.tab)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'CAPTURE_MODIFIED_COMPONENTS_4S') {
    handleCaptureModifiedComponentsWindow(message.payload || {}, sender.tab)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'RECORD_COMPONENT_FROM_DOM') {
    handleRecordComponentFromDom(message.component)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'CAPTURE_SCREENSHOT_NOW') {
    captureTabScreenshot(sender.tab?.windowId)
      .then((dataUrl) => sendResponse({ success: true, dataUrl }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'AUTO_DETECT_SSID') {
    autoDetectVaultSession(message.targetUrl)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'VERIFY_SSID') {
    verifyVaultSsid(message.vaultDns, message.ssid)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'LOGIN_VAULT_CREDENTIALS') {
    loginWithCredentials(message.vaultDns, message.username, message.password)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'MANUAL_CAPTURE_SCREENSHOT') {
    handleManualScreenshot()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'QUERY_VAULT_COMPONENTS') {
    queryVaultComponentsReadOnly(message.options || {})
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'SCAN_DOM_COMPONENTS') {
    scanActiveTabForComponents()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'UNDO_LAST_SEGMENT') {
    handleUndoLastSegment()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'INSERT_SCREENSHOT_AT') {
    handleInsertScreenshotAt(message.index)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'ENSURE_CONTENT_SCRIPTS') {
    ensureContentScriptsInOpenTabs()
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'SYNC_KEY_MODE') {
    chrome.storage.local.set({
      remoteKeyState: {
        mode: message.mode,
        sticky: Boolean(message.sticky),
        timestamp: Date.now()
      }
    });
    sendResponse({ success: true });
    return false;
  }

  if (message.type === 'FETCH_OBJECT_FIELDS') {
    fetchVaultObjectFieldsReadOnly(
      message.objectName,
      message.pageUrl,
      sender.tab,
      Boolean(message.forceRefresh)
    )
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, success: false, error: err.message }));
    return true;
  }

  if (message.type === 'DETECT_ACTIVE_VAULT_CONTEXT') {
    detectActiveVaultContext()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, success: false, error: err.message }));
    return true;
  }

  if (message.type === 'FETCH_ALL_OBJECTS_LIST') {
    fetchAllVaultObjectsReadOnly(Boolean(message.forceRefresh))
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, success: false, error: err.message }));
    return true;
  }

  if (message.type === 'QUERY_AUDIT_TRAIL_CHANGES') {
    queryAuditTrailChangesReadOnly(message.options || message)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, success: false, error: err.message }));
    return true;
  }

  if (message.type === 'NAVIGATE_VAULT_TAB') {
    navigateActiveVaultTab(message.objectName, message.fieldName, message.subPage, message.hashPath)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, success: false, error: err.message }));
    return true;
  }

  if (message.type === 'OPEN_INPAGE_ERD_MODAL') {
    openInPageErdModalOnActiveTab(message.objectName)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, success: false, error: err.message }));
    return true;
  }
});

const objectFieldsCache = new Map();
const allObjectsListCache = new Map();

async function fetchVaultObjectFieldsReadOnly(objectName, pageUrl, senderTab, forceRefresh = false) {
  const cleanObjName = (objectName || '').trim().toLowerCase();
  if (!cleanObjName) {
    return { ok: false, success: false, error: 'Missing Object Name.' };
  }

  const store = await chrome.storage.local.get(['vaultSession']);
  let session = store.vaultSession || {};
  let vaultDns = session.vaultDns || '';
  let ssid = session.ssid || '';

  const targetUrl = pageUrl || senderTab?.url || '';
  if (targetUrl && targetUrl.startsWith('http')) {
    try {
      const parsed = new URL(targetUrl);
      if (parsed.hostname.includes('veevavault.com')) {
        vaultDns = parsed.hostname;
      }
    } catch (e) {}
  }

  // If no SSID is connected yet, try auto-detecting from the active Veeva Vault tab
  if (!ssid || !vaultDns) {
    try {
      const detected = await autoDetectVaultSession(targetUrl);
      if (detected && detected.ssid) {
        ssid = detected.ssid;
      }
      if (detected && detected.vaultDns) {
        vaultDns = detected.vaultDns;
      }
    } catch (e) {}
  }

  const cacheKey = `${vaultDns || 'local'}:${cleanObjName}`;
  if (!forceRefresh && objectFieldsCache.has(cacheKey)) {
    return {
      ok: true,
      success: true,
      cached: true,
      vaultDns,
      objectName: cleanObjName,
      ...objectFieldsCache.get(cacheKey)
    };
  }

  if (!vaultDns || !ssid) {
    return {
      ok: false,
      success: false,
      needsAuth: true,
      error:
        'Connect SSID (click Auto-SSID in the extension) to load live Object fields from Veeva Vault.'
    };
  }

  const apiVersions = ['v24.1', 'v23.3', 'v22.3'];
  let lastError = 'Failed to fetch object metadata.';
  let retriedFreshSession = false;

  for (let i = 0; i < apiVersions.length; i++) {
    const ver = apiVersions[i];
    try {
      const endpoint = `https://${vaultDns}/api/${ver}/metadata/vobjects/${encodeURIComponent(
        cleanObjName
      )}`;
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          Authorization: ssid,
          Accept: 'application/json'
        }
      });

      if (!response.ok) {
        lastError = `HTTP ${response.status} from Vault API`;
        continue;
      }

      const data = await response.json();
      if (data.responseStatus === 'SUCCESS' && data.object) {
        const rawFields = Array.isArray(data.object.fields) ? data.object.fields : [];
        const fields = rawFields.map((f) => {
          const fName = f.name || '';
          const fSource =
            f.source ||
            (/__c$/i.test(fName)
              ? 'Custom'
              : /__rim$/i.test(fName)
              ? 'Application'
              : /__sys$/i.test(fName)
              ? 'System'
              : 'Standard');
          const lookupObj =
            (typeof f.object === 'object' && f.object && f.object.name) ||
            (typeof f.object === 'string' ? f.object : '') ||
            f.lookup_object_name ||
            '';
          return {
            name: fName,
            label: f.label || fName,
            type: f.type || 'Field',
            required: Boolean(f.required),
            editable: f.editable !== undefined ? Boolean(f.editable) : true,
            maxLength: f.max_length || f.length || null,
            source: fSource,
            lookupObject: lookupObj,
            objectReference: lookupObj,
            picklist: f.picklist || '',
            helpContent: f.help_content || f.description || '',
            status: Array.isArray(f.status) ? f.status[0] : f.status || 'Active'
          };
        });

        fields.sort((a, b) => a.label.localeCompare(b.label));

        const relationships = Array.isArray(data.object.relationships)
          ? data.object.relationships
          : [];

        const payload = {
          objectLabel: data.object.label || cleanObjName,
          fields,
          relationships
        };
        objectFieldsCache.set(cacheKey, payload);
        return {
          ok: true,
          success: true,
          vaultDns,
          objectName: cleanObjName,
          ...payload
        };
      } else if (data.errors && data.errors[0]) {
        const errType = data.errors[0].type || '';
        lastError = data.errors[0].message || lastError;
        // If stored SSID expired, re-detect fresh session cookie from browser and retry v24.1 once
        if (!retriedFreshSession && /SESSION/i.test(errType + ' ' + lastError)) {
          retriedFreshSession = true;
          try {
            const fresh = await autoDetectVaultSession(targetUrl);
            if (fresh && fresh.ssid && fresh.ssid !== ssid) {
              ssid = fresh.ssid;
              i = -1; // restart loop with fresh SSID
              continue;
            }
          } catch (e) {}
        }
      }
    } catch (err) {
      lastError = err.message || lastError;
    }
  }

  return {
    ok: false,
    success: false,
    error: lastError
  };
}

async function handleUndoLastSegment() {
  const store = await chrome.storage.local.get(['docSteps']);
  const docSteps = Array.isArray(store.docSteps) ? store.docSteps : [];
  if (docSteps.length === 0) {
    return { success: false, error: 'No steps to undo.' };
  }

  const last = docSteps[docSteps.length - 1];
  if (last.type === 'image') {
    docSteps.pop();
  } else if (last.type === 'text') {
    const txt = last.text || '';
    if (txt.includes('\n   > ')) {
      last.text = txt.slice(0, txt.lastIndexOf('\n   > '));
    } else if (txt.includes('\n\n')) {
      last.text = txt.slice(0, txt.lastIndexOf('\n\n'));
    } else if (txt.includes(' > ')) {
      last.text = txt.slice(0, txt.lastIndexOf(' > '));
    } else {
      docSteps.pop();
    }
  }

  await chrome.storage.local.set({ docSteps });
  broadcastUpdate(docSteps);
  return { success: true, docSteps };
}

/**
 * Finds the active target browser tab even when the extension is opened in a separate pop-out window.
 */
async function getTargetBrowserTab() {
  const allActiveTabs = await chrome.tabs.query({ active: true });
  // Filter out the extension's own sidepanel.html pop-out window
  const candidates = allActiveTabs.filter(
    (t) => t.url && !t.url.includes('sidepanel.html') && !t.url.startsWith('devtools://')
  );
  // Prefer an active *.veevavault.com tab or test-veeva-mock.html if present
  const veevaCandidate = candidates.find(
    (t) => t.url.includes('veevavault.com') || t.url.includes('test-veeva-mock.html')
  );
  if (veevaCandidate) return veevaCandidate;
  if (candidates.length > 0) return candidates[0];
  return allActiveTabs[0] || null;
}

async function handleInsertScreenshotAt(insertAfterIdx) {
  const activeTab = await getTargetBrowserTab();
  const screenshotUrl = await captureTabScreenshot(activeTab ? activeTab.windowId : null);
  const store = await chrome.storage.local.get(['docSteps']);
  const docSteps = Array.isArray(store.docSteps) ? store.docSteps : [];

  const newStep = {
    id: 'step_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    type: 'image',
    imageDataUrl: screenshotUrl,
    caption: '',
    timestamp: new Date().toISOString(),
    pageUrl: activeTab?.url || ''
  };

  if (typeof insertAfterIdx === 'number' && insertAfterIdx >= 0 && insertAfterIdx < docSteps.length) {
    docSteps.splice(insertAfterIdx + 1, 0, newStep);
  } else {
    docSteps.push(newStep);
  }

  await chrome.storage.local.set({ docSteps });
  broadcastUpdate(docSteps);
  return { success: true, step: newStep };
}

/**
 * Formats the first clicked label of a new navigation line.
 */
function formatLineStartLabel(cleanLabel, settings) {
  if (!settings.autoGoToPrefix) {
    return cleanLabel;
  }
  const startsWithVerb = /^(go to|click|remove|add|select|on |set|change|delete|create|edit|open)\b/i.test(
    cleanLabel
  );
  if (startsWithVerb) {
    return cleanLabel;
  }
  return 'Go to ' + cleanLabel;
}

const GENERIC_ACTION_BUTTON_WORDS =
  /^(save|save\s*\+\s*create|save\s*and\s*create|cancel|edit|create|delete|ok|yes|no|apply|close|submit|search|button|add|remove|continue|next|finish|back|done|confirm|reset|clear)$/i;

function isSameOrUpgradedApiName(existingApi, newApi) {
  const a = (existingApi || '').trim().toLowerCase();
  const b = (newApi || '').trim().toLowerCase();
  if (!a || !b || a === 'n/a' || b === 'n/a') return false;
  if (a === b) return true;
  if (a.endsWith('.' + b) || b.endsWith('.' + a)) return true;
  return false;
}

/**
 * Queries the most recent vault_component__v records (Read-Only VQL) and returns
 * { records, serverTimeMs } so we can detect components created or modified in [t = 0s ... t = +4s].
 */
async function fetchRecentVaultComponentsSnapshot(vaultDns, ssid) {
  if (!vaultDns || !ssid) return { records: [], serverTimeMs: 0 };

  const vqlCandidates = [
    `SELECT id, label__v, name__v, component_name__v, component_type__v, modified_date__v, created_date__v, status__v FROM vault_component__v ORDER BY modified_date__v DESC MAXROWS 40`,
    `SELECT id, name__v, component_name__v, component_type__v, modified_date__v, status__v FROM vault_component__v ORDER BY modified_date__v DESC MAXROWS 40`,
    `SELECT id, name__v, component_name__v, component_type__v, modified_date__v FROM vault_component__v MAXROWS 40`
  ];

  for (const vql of vqlCandidates) {
    try {
      const url = `https://${vaultDns}/api/v24.1/query?q=${encodeURIComponent(vql)}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: ssid,
          Accept: 'application/json'
        }
      });
      if (!response.ok) continue;
      const dateHdr = response.headers.get('date');
      const serverTimeMs = dateHdr ? new Date(dateHdr).getTime() : 0;
      const data = await response.json();
      if (data.responseStatus === 'SUCCESS' && Array.isArray(data.data)) {
        return { records: data.data, serverTimeMs: isNaN(serverTimeMs) ? 0 : serverTimeMs };
      }
    } catch (e) {}
  }

  return { records: [], serverTimeMs: 0 };
}

function formatVaultComponentRow(row) {
  const label = row.label__v || row.name__v || row.component_name__v || 'Component';
  const statusPrefix =
    Array.isArray(row.status__v) && row.status__v[0] && /inactive/i.test(row.status__v[0])
      ? '(Inactive) '
      : typeof row.status__v === 'string' && /inactive/i.test(row.status__v)
      ? '(Inactive) '
      : '';
  const fullLabel =
    statusPrefix && !label.startsWith('(Inactive)') ? `${statusPrefix}${label}` : label;

  return {
    name: fullLabel,
    componentName: row.component_name__v || row.name__v || 'n/a',
    componentType: row.component_type__v || 'Component',
    modifiedDate: formatVeevaDateRange(row.modified_date__v, row.created_date__v)
  };
}

/**
 * Captures components created or modified in the 4-second time interval between
 * the exact moment of pressing 4+Left Click (t = 0s) and 4 seconds after (t = +4s).
 * Saves all captured components in the exact Components format to BOTH:
 * - `affectedComponents` (regular Components, clearable by external Reset All)
 * - `allComponents` (All Components, protected from external Reset All)
 */
async function handleCaptureModifiedComponentsWindow(payload, senderTab) {
  const clickTimestampMs = Number(payload?.clickTimestampMs) || Date.now();
  const windowMs = Number(payload?.windowMs) || 4000;
  const targetUrl = payload?.pageUrl || senderTab?.url || '';

  const capturedEntries = [];

  const saveCandidateImmediately = async (comp) => {
    if (!comp) return;
    const rawApi = (comp.componentName || comp.apiName || '').trim();
    const rawName = (comp.name || comp.label || '').trim();
    const rawType = (comp.componentType || 'Component').trim();
    if (!rawApi && !rawName) return;
    if (
      GENERIC_ACTION_BUTTON_WORDS.test(rawName) &&
      (!rawApi ||
        rawApi.toLowerCase() === 'n/a' ||
        GENERIC_ACTION_BUTTON_WORDS.test(rawApi.replace(/__(?:c|v|sys|cda|rim)$/i, '')))
    ) {
      return;
    }

    const entry = {
      name: rawName || rawApi || 'Unnamed Component',
      componentName: rawApi || 'n/a',
      componentType: rawType || 'Component',
      modifiedDate:
        comp.modifiedDate ||
        formatVeevaDateRange(new Date().toISOString(), new Date().toISOString())
    };

    const existingCapturedIdx = capturedEntries.findIndex(
      (c) =>
        isSameOrUpgradedApiName(c.componentName, entry.componentName) ||
        (c.name.toLowerCase() === entry.name.toLowerCase() &&
          c.componentType.toLowerCase() === entry.componentType.toLowerCase())
    );
    if (existingCapturedIdx >= 0) {
      const prev = capturedEntries[existingCapturedIdx];
      capturedEntries[existingCapturedIdx] = {
        ...prev,
        ...entry,
        componentName:
          prev.componentName &&
          prev.componentName.includes('.') &&
          !entry.componentName.includes('.')
            ? prev.componentName
            : entry.componentName
      };
    } else {
      capturedEntries.push(entry);
    }

    const curStore = await chrome.storage.local.get(['affectedComponents', 'allComponents']);
    const affectedComponents = Array.isArray(curStore.affectedComponents)
      ? curStore.affectedComponents
      : [];
    const allComponents = Array.isArray(curStore.allComponents) ? curStore.allComponents : [];
    upsertIntoBothComponentLists(affectedComponents, allComponents, entry);
    await chrome.storage.local.set({ affectedComponents, allComponents });
    broadcastComponentsUpdate(affectedComponents, allComponents);
  };

  // Resolve Vault session (auto-detecting from open tab if needed)
  const store = await chrome.storage.local.get(['vaultSession']);
  let session = store.vaultSession || {};
  let vaultDns = session.vaultDns || '';
  let ssid = session.ssid || '';

  if ((!vaultDns || !ssid) && targetUrl) {
    try {
      const detected = await autoDetectVaultSession(targetUrl);
      if (detected && detected.ssid) ssid = detected.ssid;
      if (detected && detected.vaultDns) vaultDns = detected.vaultDns;
    } catch (e) {}
  }

  // 1) At t = 0s (moment of button press):
  //    a) Save any active component being created/modified on the page right at t = 0s
  if (payload?.componentData) {
    await saveCandidateImmediately(payload.componentData);
  }
  if (Array.isArray(payload?.initialComponents)) {
    for (const c of payload.initialComponents) {
      await saveCandidateImmediately(c);
    }
  }
  try {
    const domAtT0 = await scanActiveTabForCreatedOrModifiedComponents(senderTab);
    for (const c of domAtT0) {
      await saveCandidateImmediately(c);
    }
  } catch (e) {}

  //    b) Take a t = 0s baseline snapshot of vault_component__v so we can detect any component
  //       created or modified between t = 0s and t = +4s regardless of clock skew!
  const baselineModMap = new Map();
  let serverT0Ms = clickTimestampMs;

  if (vaultDns && ssid) {
    const snap0 = await fetchRecentVaultComponentsSnapshot(vaultDns, ssid);
    if (snap0.serverTimeMs > 0) {
      serverT0Ms = snap0.serverTimeMs;
    }
    for (const row of snap0.records) {
      const key = (row.component_name__v || row.name__v || row.id || '').toLowerCase();
      const modStr = row.modified_date__v || row.created_date__v || '';
      const modMs = row.modified_date__v ? new Date(row.modified_date__v).getTime() : 0;
      const creMs = row.created_date__v ? new Date(row.created_date__v).getTime() : 0;
      const latestMs = Math.max(modMs || 0, creMs || 0);

      // If a component was created/modified right at the moment of button press (t = 0s, within 2s of serverT0Ms), capture it immediately
      if (latestMs > 0 && Math.abs(latestMs - serverT0Ms) <= 2000) {
        await saveCandidateImmediately(formatVaultComponentRow(row));
      }
      if (key) {
        baselineModMap.set(key, modStr);
      }
    }
  }

  // 2) Poll across the [t = 0s ... t = +4s] interval (at +1s, +2s, +3s, and +4s)
  const checkDelays = [1000, 1000, 1000, 1000]; // cumulative: 1000ms, 2000ms, 3000ms, 4000ms

  for (let i = 0; i < checkDelays.length; i++) {
    await new Promise((r) => setTimeout(r, checkDelays[i]));

    // A) Check Vault API (vault_component__v) for any component created or modified in [0s ... +4s]
    if (vaultDns && ssid) {
      const snap = await fetchRecentVaultComponentsSnapshot(vaultDns, ssid);
      for (const row of snap.records) {
        const key = (row.component_name__v || row.name__v || row.id || '').toLowerCase();
        const modStr = row.modified_date__v || row.created_date__v || '';
        const modMs = row.modified_date__v ? new Date(row.modified_date__v).getTime() : 0;
        const creMs = row.created_date__v ? new Date(row.created_date__v).getTime() : 0;
        const latestMs = Math.max(modMs || 0, creMs || 0);

        const wasInBaseline = key && baselineModMap.has(key);
        const baselineModStr = wasInBaseline ? baselineModMap.get(key) : null;

        // Created or modified in [t = 0s ... t = +4s] if:
        // 1) Its modified_date__v changed since t = 0s, OR
        // 2) It is a brand-new component not in the top recent list at t = 0s (and timestamp is recent), OR
        // 3) Its timestamp falls within [serverT0Ms - 2000ms, serverT0Ms + windowMs + 2000ms]
        const changedSinceT0 = wasInBaseline && modStr && modStr !== baselineModStr;
        const inServerWindow =
          latestMs > 0 &&
          latestMs >= serverT0Ms - 2000 &&
          latestMs <= serverT0Ms + windowMs + 2500;
        const newlyCreatedInWindow =
          !wasInBaseline &&
          baselineModMap.size > 0 &&
          (!latestMs || latestMs >= serverT0Ms - 5000);

        if (changedSinceT0 || inServerWindow || newlyCreatedInWindow) {
          await saveCandidateImmediately(formatVaultComponentRow(row));
          if (key) baselineModMap.set(key, modStr);
        }
      }
    }

    // B) Also scan active tab DOM across all frames during [0s ... +4s]
    try {
      const domItems = await scanActiveTabForCreatedOrModifiedComponents(senderTab);
      for (const c of domItems) {
        await saveCandidateImmediately(c);
      }
    } catch (e) {}
  }

  return {
    ok: true,
    success: true,
    action: 'component_recorded_4s',
    capturedCount: capturedEntries.length,
    component: capturedEntries[0] || null,
    components: capturedEntries
  };
}

/**
 * Inspects all frames of the active Veeva Vault tab's DOM (without writing anything) to extract
 * any component currently being created, edited, or viewed on the page during [0s ... +4s].
 */
async function scanActiveTabForCreatedOrModifiedComponents(preferredTab) {
  const activeTab = preferredTab || (await getTargetBrowserTab());
  if (!activeTab || !activeTab.id || !activeTab.url || activeTab.url.startsWith('chrome://')) {
    return [];
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id, allFrames: true },
      func: () => {
        const out = [];
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const btnRegex =
          /^(save|save\s*\+\s*create|save\s*and\s*create|cancel|edit|create|delete|ok|yes|no|apply|close|submit|search|button|add|remove|continue|next|finish|back|done|confirm|reset|clear)$/i;

        let href = window.location.href || '';
        let hash = window.location.hash || '';
        try {
          if (window.top && window.top.location) {
            href = window.top.location.href || href;
            hash = window.top.location.hash || hash;
          }
        } catch (e) {}

        const combinedUrl = `${hash} ${href}`;
        const objMatch =
          combinedUrl.match(/[?&]t=([a-z0-9_]+__(?:v|c|sys|rim|cda))/i) ||
          combinedUrl.match(/\/objects\/([a-z0-9_]+__(?:v|c|sys|rim|cda))/i);
        const fldMatch =
          combinedUrl.match(/[?&]d=([a-z0-9_]+__(?:v|c|sys|rim|cda))/i) ||
          combinedUrl.match(/\/fields\/([a-z0-9_]+__(?:v|c|sys|rim|cda))/i);

        let formLabel = '';
        let formApiName = '';
        let formStatusInactive = false;
        let formType = '';

        // 1. Inspect Veeva label-value form rows (Create, Edit, and Read-Only Detail views)
        const rows = Array.from(
          document.querySelectorAll(
            '.vv_field_row, .vv-field-row, .vv_property, .form-group, tr, [role="row"]'
          )
        );
        for (const r of rows) {
          const labelEl = r.querySelector(
            'label, th, td:first-child, .vv_field_label, .vv-label, .property-label'
          );
          if (!labelEl) continue;
          const rawPropLabel = clean(labelEl.textContent).replace(/[:*]+$/g, '').trim().toLowerCase();
          if (!rawPropLabel || rawPropLabel.length > 40) continue;

          const valContainer =
            r.querySelector('td:nth-child(2), .vv_field_value, .vv-value, .property-value') || r;
          const inp = valContainer.querySelector(
            'input[type="text"], input:not([type]), textarea, select'
          );
          let valText = '';
          if (inp) {
            if (inp.tagName === 'SELECT') {
              valText = clean(inp.options?.[inp.selectedIndex]?.text || inp.value || '');
            } else {
              valText = clean(inp.value || '');
            }
          } else if (valContainer !== r) {
            valText = clean(valContainer.textContent || '');
          } else {
            const clone = r.cloneNode(true);
            const firstLbl = clone.querySelector(
              'label, th, td:first-child, .vv_field_label, .vv-label, .property-label'
            );
            if (firstLbl) firstLbl.remove();
            valText = clean(clone.textContent || '');
          }

          if (!valText) continue;

          if (
            (rawPropLabel === 'label' ||
              rawPropLabel === 'singular label' ||
              rawPropLabel === 'display name' ||
              rawPropLabel === 'report name') &&
            !formLabel &&
            !btnRegex.test(valText)
          ) {
            formLabel = valText;
          }

          if (
            rawPropLabel === 'name' ||
            rawPropLabel === 'api name' ||
            rawPropLabel === 'field name' ||
            rawPropLabel === 'object name' ||
            rawPropLabel === 'component name' ||
            rawPropLabel === 'picklist name' ||
            rawPropLabel === 'lifecycle name' ||
            rawPropLabel === 'workflow name'
          ) {
            const directApi = valText.match(/\b([a-z][a-z0-9_.]*__(?:c|v|sys|cda|rim))\b/i);
            if (directApi && !formApiName) {
              formApiName = directApi[1];
            } else if (inp && /^[a-z][a-z0-9_]*$/i.test(valText)) {
              const suffixMatch = clean(valContainer.textContent).match(/__(?:c|v|sys|cda|rim)\b/i);
              const suffix = suffixMatch ? suffixMatch[0] : '__c';
              if (!formApiName) {
                formApiName = `${valText.toLowerCase()}${suffix.toLowerCase()}`;
              }
            } else if (!formLabel && !valText.includes('__') && !btnRegex.test(valText)) {
              formLabel = valText;
            }
          }

          if (rawPropLabel === 'status' && /\binactive\b/i.test(valText)) {
            formStatusInactive = true;
          }
        }

        // 2. Fallback scan of text inputs
        if (!formApiName || !formLabel) {
          const inputs = Array.from(
            document.querySelectorAll('input[type="text"], input:not([type])')
          );
          for (const inp of inputs) {
            const val = clean(inp.value);
            if (!val || btnRegex.test(val)) continue;
            const nameAttr = (
              inp.name ||
              inp.id ||
              inp.getAttribute('data-name') ||
              inp.getAttribute('aria-label') ||
              inp.getAttribute('placeholder') ||
              ''
            ).toLowerCase();
            if (/^[a-z][a-z0-9_.]*__(?:c|v|sys|cda|rim)$/i.test(val)) {
              if (!formApiName) formApiName = val;
            } else if (
              nameAttr.includes('label') ||
              nameAttr.includes('title') ||
              (nameAttr.includes('name') && !nameAttr.includes('api'))
            ) {
              if (!formLabel && val.length < 120) formLabel = val;
            }
          }
        }

        const pageCtx = (combinedUrl + ' ' + document.title).toLowerCase();
        if (fldMatch || pageCtx.includes('/fields')) formType = 'Objectfield';
        else if (pageCtx.includes('object_schema') || pageCtx.includes('objects')) formType = 'Object';
        else if (pageCtx.includes('picklist')) formType = 'Picklist';
        else if (pageCtx.includes('doctype') || pageCtx.includes('document_type')) formType = 'Doctype';
        else if (pageCtx.includes('docfield') || pageCtx.includes('document_field')) formType = 'Docfield';
        else if (pageCtx.includes('lifecycle')) formType = 'Objectlifecycle';
        else if (pageCtx.includes('workflow')) formType = 'Workflow';
        else if (pageCtx.includes('layout')) formType = 'Objectlayout';
        else if (pageCtx.includes('report')) formType = 'Report';
        else formType = 'Component';

        const formatLbl = (lbl) => {
          const c = (lbl || '').trim();
          if (!c) return '';
          return formStatusInactive && !c.startsWith('(Inactive)') ? `(Inactive) ${c}` : c;
        };

        if (fldMatch && fldMatch[1]) {
          const fieldApi = formApiName || fldMatch[1];
          const fullApi =
            objMatch && objMatch[1] && !fieldApi.includes('.')
              ? `${objMatch[1]}.${fieldApi}`
              : fieldApi;
          out.push({
            name: formatLbl(formLabel || fldMatch[1]),
            componentName: fullApi,
            componentType: 'Objectfield'
          });
        } else if (formApiName) {
          const fullApi =
            objMatch &&
            objMatch[1] &&
            formType === 'Objectfield' &&
            !formApiName.includes('.')
              ? `${objMatch[1]}.${formApiName}`
              : formApiName;
          out.push({
            name: formatLbl(formLabel || formApiName),
            componentName: fullApi,
            componentType: formType
          });
        } else if (objMatch && objMatch[1]) {
          const h1 = clean(
            document.querySelector(
              '.vv_page_title, .pageTitle, h1, h2, .vv_header_title'
            )?.textContent || ''
          );
          const bestH1 = h1 && !btnRegex.test(h1) ? h1 : '';
          out.push({
            name: formatLbl(formLabel || bestH1 || objMatch[1]),
            componentName: objMatch[1],
            componentType: formType || 'Object'
          });
        }

        return out;
      }
    });

    const merged = [];
    if (Array.isArray(results)) {
      for (const frameRes of results) {
        if (frameRes && Array.isArray(frameRes.result)) {
          merged.push(...frameRes.result);
        }
      }
    }
    return merged;
  } catch (e) {
    return [];
  }
}

/**
 * Handles 0+Click, 1+Click, 2+Click, 3+Click, and 4+Click actions from content.js
 */
async function handleRecordAction(payload, tab) {
  const { mode, label, pageUrl, dataUrl, componentData } = payload;
  const store = await chrome.storage.local.get([
    'docSteps',
    'settings',
    'affectedComponents',
    'allComponents'
  ]);
  const docSteps = Array.isArray(store.docSteps) ? store.docSteps : [];
  const affectedComponents = Array.isArray(store.affectedComponents)
    ? store.affectedComponents
    : [];
  const allComponents = Array.isArray(store.allComponents) ? store.allComponents : [];
  const settings = { ...DEFAULT_SETTINGS, ...(store.settings || {}) };

  if (!settings.isRecording) {
    return { success: false, ignored: true, reason: 'Recording is paused' };
  }

  const timestamp = new Date().toISOString();

  // Mode 4: 4 + Left Click -> Capture components at the moment of click (t = 0s) AND
  // components created or modified within 4 seconds after the click (t = +4s).
  // Saves to BOTH `affectedComponents` (regular Components) and `allComponents` (All Components).
  if (mode === '4') {
    return await handleCaptureModifiedComponentsWindow(payload, tab);
  }

  // Also auto-track any component technical name (__c / __v) spotted during 0/1/3 clicks
  if (componentData && componentData.componentName && componentData.componentName !== 'n/a') {
    upsertIntoBothComponentLists(affectedComponents, allComponents, componentData);
    await chrome.storage.local.set({ affectedComponents, allComponents });
    broadcastComponentsUpdate(affectedComponents, allComponents);
  }

  if (mode === '2') {
    let screenshotUrl = dataUrl;
    if (!screenshotUrl) {
      screenshotUrl = await captureTabScreenshot(tab ? tab.windowId : null);
    }
    const newStep = {
      id: 'step_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      type: 'image',
      imageDataUrl: screenshotUrl,
      caption: label ? `Screenshot: ${label}` : '',
      timestamp,
      pageUrl: pageUrl || tab?.url || ''
    };
    docSteps.push(newStep);
    await chrome.storage.local.set({ docSteps });
    broadcastUpdate(docSteps);
    return { success: true, step: newStep, action: 'screenshot_added' };
  }

  const cleanLabel = (label || '').trim();
  if (!cleanLabel) {
    return { success: false, error: 'Empty label clicked' };
  }

  const lastStep = docSteps.length > 0 ? docSteps[docSteps.length - 1] : null;

  if (mode === '0') {
    if (lastStep && lastStep.type === 'text') {
      if (lastStep.text.endsWith('\n') || lastStep.text.endsWith('\n   > ')) {
        lastStep.text += cleanLabel;
      } else if (!lastStep.text.trim()) {
        lastStep.text = formatLineStartLabel(cleanLabel, settings);
      } else {
        lastStep.text += ' > ' + cleanLabel;
      }
      lastStep.updatedAt = timestamp;
    } else {
      const initialText = formatLineStartLabel(cleanLabel, settings);
      docSteps.push({
        id: 'step_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        type: 'text',
        text: initialText,
        timestamp,
        pageUrl: pageUrl || tab?.url || ''
      });
    }
  } else if (mode === '1') {
    if (settings.mode1Style === 'sub_item') {
      if (lastStep && lastStep.type === 'text') {
        lastStep.text += '\n   > ' + cleanLabel;
        lastStep.updatedAt = timestamp;
      } else {
        docSteps.push({
          id: 'step_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
          type: 'text',
          text: '   > ' + cleanLabel,
          timestamp,
          pageUrl: pageUrl || tab?.url || ''
        });
      }
    } else if (settings.mode1Style === 'new_block') {
      const initialText = formatLineStartLabel(cleanLabel, settings);
      docSteps.push({
        id: 'step_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        type: 'text',
        text: initialText,
        timestamp,
        pageUrl: pageUrl || tab?.url || ''
      });
    } else {
      // Default 'blank_line': Inserts in a new line with 1 empty line skipped (\n\n)
      const lineStart = formatLineStartLabel(cleanLabel, settings);
      if (lastStep && lastStep.type === 'text') {
        lastStep.text += '\n\n' + lineStart;
        lastStep.updatedAt = timestamp;
      } else {
        docSteps.push({
          id: 'step_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
          type: 'text',
          text: lineStart,
          timestamp,
          pageUrl: pageUrl || tab?.url || ''
        });
      }
    }
  } else if (mode === '3') {
    if (lastStep && lastStep.type === 'text') {
      lastStep.text += '\n   > ' + cleanLabel;
      lastStep.updatedAt = timestamp;
    } else {
      docSteps.push({
        id: 'step_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        type: 'text',
        text: '   > ' + cleanLabel,
        timestamp,
        pageUrl: pageUrl || tab?.url || ''
      });
    }
  }

  await chrome.storage.local.set({ docSteps });
  broadcastUpdate(docSteps);
  return {
    success: true,
    step: docSteps[docSteps.length - 1],
    action: 'text_recorded'
  };
}

function upsertComponent(list, comp) {
  const normName = (comp.componentName || comp.apiName || '').trim();
  const normLabel = (comp.name || comp.label || '').trim();
  const normType = (comp.componentType || 'Component').trim();
  const existingIdx = list.findIndex(
    (c) =>
      isSameOrUpgradedApiName(c.componentName, normName) ||
      ((!normName || normName === 'n/a') &&
        normLabel &&
        (c.name || '').toLowerCase() === normLabel.toLowerCase() &&
        (c.componentType || '').toLowerCase() === normType.toLowerCase())
  );

  const chosenApi =
    existingIdx >= 0 &&
    list[existingIdx].componentName &&
    list[existingIdx].componentName.includes('.') &&
    normName &&
    !normName.includes('.')
      ? list[existingIdx].componentName
      : normName || (existingIdx >= 0 ? list[existingIdx].componentName : 'n/a') || 'n/a';

  const chosenName =
    normLabel && !/^[a-z0-9_.]+__(?:c|v|sys|cda|rim)$/i.test(normLabel)
      ? normLabel
      : existingIdx >= 0 && list[existingIdx].name
      ? list[existingIdx].name
      : normLabel || chosenApi || 'Unnamed Component';

  const entry = {
    id: comp.id || 'comp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    name: chosenName,
    componentName: chosenApi,
    componentType: normType || (existingIdx >= 0 ? list[existingIdx].componentType : 'Component') || 'Component',
    modifiedDate:
      comp.modifiedDate ||
      formatVeevaDateRange(new Date().toISOString(), new Date().toISOString())
  };

  if (existingIdx >= 0) {
    list[existingIdx] = { ...list[existingIdx], ...entry, id: list[existingIdx].id };
    return list[existingIdx];
  } else {
    list.push(entry);
    return entry;
  }
}

function upsertIntoBothComponentLists(affectedComponents, allComponents, comp) {
  const addedAff = upsertComponent(affectedComponents, {
    ...comp,
    id: comp.id || 'comp_aff_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)
  });
  upsertComponent(allComponents, {
    ...comp,
    id: 'comp_all_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)
  });
  return addedAff;
}

async function handleRecordComponentFromDom(comp) {
  const store = await chrome.storage.local.get(['affectedComponents', 'allComponents']);
  const affectedComponents = Array.isArray(store.affectedComponents)
    ? store.affectedComponents
    : [];
  const allComponents = Array.isArray(store.allComponents) ? store.allComponents : [];
  const added = upsertIntoBothComponentLists(affectedComponents, allComponents, comp);
  await chrome.storage.local.set({ affectedComponents, allComponents });
  broadcastComponentsUpdate(affectedComponents, allComponents);
  return { success: true, component: added };
}

/**
 * Strictly READ-ONLY VQL Query against Veeva Vault to fetch modified/affected components
 */
async function queryVaultComponentsReadOnly(options) {
  const store = await chrome.storage.local.get([
    'vaultSession',
    'docSteps',
    'affectedComponents',
    'allComponents',
    'docMeta'
  ]);
  const session = store.vaultSession || {};
  const docSteps = store.docSteps || [];
  const affectedComponents = Array.isArray(store.affectedComponents)
    ? store.affectedComponents
    : [];
  const allComponents = Array.isArray(store.allComponents) ? store.allComponents : [];

  const mentionedApiNames = extractMentionedApiNamesFromSteps(docSteps);

  if (!session.connected || !session.vaultDns || !session.ssid) {
    const domResult = await scanActiveTabForComponents(mentionedApiNames);
    if (domResult.components && domResult.components.length > 0) {
      return {
        success: true,
        source: 'DOM_SCAN',
        addedCount: domResult.addedCount,
        components: domResult.components,
        message: `${domResult.addedCount} component(s) scanned from the active page (Read-Only)!`
      };
    }
    throw new Error(
      'No active SSID connection to Veeva Vault API. Please connect via SSID (Auto-SSID) or use 4+Click / Page Scan!'
    );
  }

  const vaultDns = session.vaultDns;
  const ssid = session.ssid;
  const filterMode = options.filterMode || 'recent_today';
  const searchKeyword = (options.searchKeyword || '').trim();

  let whereClauses = [];

  if (filterMode === 'recent_1h') {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    whereClauses.push(`modified_date__v >= '${oneHourAgo}'`);
  } else if (filterMode === 'recent_today') {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    whereClauses.push(`modified_date__v >= '${startOfDay.toISOString()}'`);
  } else if (filterMode === 'from_steps' && mentionedApiNames.length > 0) {
    const quoted = mentionedApiNames
      .slice(0, 25)
      .map((n) => `'${n.replace(/'/g, '')}'`)
      .join(', ');
    whereClauses.push(`component_name__v CONTAINS (${quoted})`);
  }

  if (searchKeyword) {
    const safeKw = searchKeyword.replace(/'/g, '');
    whereClauses.push(
      `(component_name__v CONTAINS '${safeKw}' OR label__v CONTAINS '${safeKw}' OR component_type__v CONTAINS '${safeKw}')`
    );
  }

  const whereSql = whereClauses.length > 0 ? ` WHERE ${whereClauses.join(' AND ')}` : '';

  const vqlCandidates = [
    `SELECT id, label__v, name__v, component_name__v, component_type__v, modified_date__v, created_date__v, status__v FROM vault_component__v${whereSql} ORDER BY modified_date__v DESC MAXROWS 50`,
    `SELECT id, name__v, component_name__v, component_type__v, modified_date__v FROM vault_component__v${whereSql} MAXROWS 50`,
    `SELECT component_name__v, component_type__v FROM vault_component__v${whereSql} MAXROWS 50`
  ];

  let records = [];
  let lastApiError = '';

  for (const vql of vqlCandidates) {
    try {
      const url = `https://${vaultDns}/api/v24.1/query?q=${encodeURIComponent(vql)}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: ssid,
          Accept: 'application/json'
        }
      });

      if (response.ok) {
        const data = await response.json();
        if (data.responseStatus === 'SUCCESS' && Array.isArray(data.data)) {
          records = data.data;
          break;
        } else if (data.errors && data.errors[0]) {
          lastApiError = data.errors[0].message;
        }
      }
    } catch (err) {
      lastApiError = err.message;
    }
  }

  let addedCount = 0;
  for (const row of records) {
    const label = row.label__v || row.name__v || row.component_name__v || 'Component';
    const statusPrefix =
      Array.isArray(row.status__v) && row.status__v[0] && /inactive/i.test(row.status__v[0])
        ? '(Inactive) '
        : typeof row.status__v === 'string' && /inactive/i.test(row.status__v)
        ? '(Inactive) '
        : '';

    const fullLabel =
      statusPrefix && !label.startsWith('(Inactive)') ? `${statusPrefix}${label}` : label;

    const compEntry = {
      name: fullLabel,
      componentName: row.component_name__v || row.name__v || '',
      componentType: row.component_type__v || 'Component',
      modifiedDate: formatVeevaDateRange(row.modified_date__v, row.created_date__v)
    };
    upsertIntoBothComponentLists(affectedComponents, allComponents, compEntry);
    addedCount++;
  }

  if (addedCount === 0) {
    const domFallback = await scanActiveTabForComponents(mentionedApiNames);
    if (domFallback && domFallback.addedCount > 0) {
      return {
        success: true,
        source: 'DOM_FALLBACK',
        addedCount: domFallback.addedCount,
        components: domFallback.components,
        message: `VQL returned 0 matches, scanned ${domFallback.addedCount} component(s) from the active page!`
      };
    }
  }

  await chrome.storage.local.set({ affectedComponents, allComponents });
  broadcastComponentsUpdate(affectedComponents, allComponents);

  return {
    success: true,
    source: 'VQL_API',
    addedCount,
    components: affectedComponents,
    allComponents,
    message:
      addedCount > 0
        ? `${addedCount} affected component(s) queried from Veeva Vault (Read-Only VQL)!`
        : `Query completed, no new components found with the current filter. ${lastApiError ? '(' + lastApiError + ')' : ''}`
  };
}

function extractMentionedApiNamesFromSteps(docSteps) {
  const found = new Set();
  for (const step of docSteps) {
    if (step.type === 'text' && step.text) {
      const matches = step.text.match(/\b([a-z][a-z0-9_]*__(?:c|v|sys|cda|rim))\b/gi);
      if (matches) {
        matches.forEach((m) => found.add(m.toLowerCase()));
      }
    }
  }
  return Array.from(found);
}

function formatVeevaDateRange(modIso, createIso) {
  const d1 = formatSingleVeevaDate(modIso || new Date().toISOString());
  const d2 = formatSingleVeevaDate(createIso || modIso || new Date().toISOString());
  return `${d1} - ${d2}`;
}

function formatSingleVeevaDate(isoStr) {
  if (!isoStr) return '';
  if (/^\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}\s*(AM|PM)/i.test(String(isoStr).trim())) {
    return String(isoStr).trim();
  }
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return String(isoStr);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  if (hours === 0) hours = 12;
  return `${yyyy}-${mm}-${dd} ${hours}:${minutes} ${ampm}`;
}

async function scanActiveTabForComponents() {
  const activeTab = await getTargetBrowserTab();
  if (!activeTab || !activeTab.id) {
    return { success: false, addedCount: 0, components: [] };
  }

  const store = await chrome.storage.local.get(['affectedComponents', 'allComponents']);
  const affectedComponents = Array.isArray(store.affectedComponents)
    ? store.affectedComponents
    : [];
  const allComponents = Array.isArray(store.allComponents) ? store.allComponents : [];

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      func: () => {
        const extracted = [];
        document
          .querySelectorAll('[data-component-name], [data-api-name], tr, .vv-component-row')
          .forEach((row) => {
            const compName =
              row.getAttribute('data-component-name') || row.getAttribute('data-api-name') || '';
            const compLabel = row.getAttribute('data-component-label') || '';
            const compType = row.getAttribute('data-component-type') || '';
            const compMod = row.getAttribute('data-modified-date') || '';

            if (compName && compLabel) {
              extracted.push({
                name: compLabel,
                componentName: compName,
                componentType: compType || 'Component',
                modifiedDate: compMod || ''
              });
              return;
            }

            if (row.tagName === 'TR') {
              const cells = Array.from(row.querySelectorAll('td')).map((td) =>
                (td.textContent || '').trim()
              );
              if (cells.length >= 2) {
                const apiCellIdx = cells.findIndex((c) =>
                  /^[a-z0-9_.]+__(?:c|v|sys|cda|rim)$/i.test(c)
                );
                if (apiCellIdx >= 0) {
                  const apiVal = cells[apiCellIdx];
                  const labelVal = apiCellIdx > 0 ? cells[0] : cells[1] || apiVal;
                  const typeVal = cells[apiCellIdx + 1] || 'Component';
                  const dateVal = cells[apiCellIdx + 2] || '';
                  extracted.push({
                    name: labelVal,
                    componentName: apiVal,
                    componentType: typeVal,
                    modifiedDate: dateVal
                  });
                }
              }
            }
          });
        return extracted;
      }
    });

    const foundList = (results && results[0] && results[0].result) || [];
    let addedCount = 0;
    for (const item of foundList) {
      upsertIntoBothComponentLists(affectedComponents, allComponents, item);
      addedCount++;
    }

    if (addedCount > 0) {
      await chrome.storage.local.set({ affectedComponents, allComponents });
      broadcastComponentsUpdate(affectedComponents, allComponents);
    }

    return {
      success: true,
      addedCount,
      components: affectedComponents,
      allComponents
    };
  } catch (err) {
    return { success: false, addedCount: 0, components: affectedComponents, error: err.message };
  }
}

async function handleManualScreenshot() {
  const activeTab = await getTargetBrowserTab();
  const screenshotUrl = await captureTabScreenshot(activeTab ? activeTab.windowId : null);
  const store = await chrome.storage.local.get(['docSteps']);
  const docSteps = Array.isArray(store.docSteps) ? store.docSteps : [];

  const newStep = {
    id: 'step_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    type: 'image',
    imageDataUrl: screenshotUrl,
    caption: '',
    timestamp: new Date().toISOString(),
    pageUrl: activeTab?.url || ''
  };
  docSteps.push(newStep);
  await chrome.storage.local.set({ docSteps });
  broadcastUpdate(docSteps);
  return { success: true, step: newStep };
}

function captureTabScreenshot(windowId) {
  return new Promise((resolve, reject) => {
    const targetWindowId = windowId || chrome.windows.WINDOW_ID_CURRENT;
    chrome.tabs.captureVisibleTab(targetWindowId, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(dataUrl);
      }
    });
  });
}

function broadcastUpdate(docSteps) {
  chrome.runtime.sendMessage({ type: 'STEPS_UPDATED', docSteps }).catch(() => {});
}

function broadcastComponentsUpdate(affectedComponents, allComponents) {
  chrome.runtime
    .sendMessage({ type: 'COMPONENTS_UPDATED', affectedComponents, allComponents })
    .catch(() => {});
}

async function autoDetectVaultSession(targetUrl) {
  let vaultTab = await getTargetBrowserTab();

  if (!vaultTab?.url || !vaultTab.url.includes('veevavault.com')) {
    const allVaultTabs = await chrome.tabs.query({ url: '*://*.veevavault.com/*' });
    if (allVaultTabs.length > 0) {
      vaultTab = allVaultTabs[0];
    }
  }

  let urlToInspect = targetUrl || vaultTab?.url || '';
  let vaultDns = '';
  try {
    if (urlToInspect && urlToInspect.startsWith('http')) {
      const parsed = new URL(urlToInspect);
      vaultDns = parsed.hostname;
    }
  } catch (e) {}

  let detectedSsid = '';

  if (urlToInspect && urlToInspect.startsWith('http')) {
    try {
      const parsed = new URL(urlToInspect);
      const byOrigin = await chrome.cookies.getAll({ url: parsed.origin });
      const byDomain = vaultDns ? await chrome.cookies.getAll({ domain: vaultDns }) : [];
      const cookieMap = new Map();
      [...byOrigin, ...byDomain].forEach((c) => {
        if (c && c.name && c.value) {
          cookieMap.set(`${c.name}:${c.path || ''}`, c);
        }
      });
      const cookies = Array.from(cookieMap.values());
      const sessionCookieNames = ['TK', 'vaultSessionId', 'SESSION_ID', 'veeva_session_id', 'sid'];
      for (const name of sessionCookieNames) {
        const match = cookies.find(
          (c) => c.name.toLowerCase() === name.toLowerCase() && c.value && c.value.length > 15
        );
        if (match) {
          detectedSsid = match.value;
          break;
        }
      }
      if (!detectedSsid && vaultDns.includes('veevavault.com')) {
        const tokenCandidate = cookies.find(
          (c) => /^[A-Za-z0-9_.-]{24,512}$/.test(c.value) && !c.name.startsWith('_ga')
        );
        if (tokenCandidate) {
          detectedSsid = tokenCandidate.value;
        }
      }
    } catch (err) {
      console.warn('Cookie inspection warning:', err);
    }
  }

  if (!detectedSsid && vaultTab?.id && vaultTab.url && !vaultTab.url.startsWith('chrome://')) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: vaultTab.id },
        world: 'MAIN',
        func: () => {
          try {
            if (window.Vault && window.Vault.sessionId) return window.Vault.sessionId;
            if (window.veeva && window.veeva.sessionId) return window.veeva.sessionId;
            for (let i = 0; i < sessionStorage.length; i++) {
              const k = sessionStorage.key(i);
              const v = sessionStorage.getItem(k);
              if (k && /session|ssid|tk/i.test(k) && v && v.length > 20 && v.length < 300) {
                return v.replace(/^"|"$/g, '');
              }
            }
            const m = document.cookie.match(/(?:^|;\s*)TK=([^;]+)/);
            if (m) return decodeURIComponent(m[1]);
          } catch (e) {}
          return '';
        }
      });
      if (results && results[0] && results[0].result) {
        detectedSsid = results[0].result;
      }
    } catch (err) {}
  }

  if (detectedSsid && vaultDns) {
    const verifyRes = await verifyVaultSsid(vaultDns, detectedSsid);
    return {
      ...verifyRes,
      vaultDns,
      ssid: detectedSsid,
      autoDetected: true
    };
  }

  return {
    success: Boolean(vaultDns || detectedSsid),
    vaultDns,
    ssid: detectedSsid,
    message: detectedSsid
      ? 'SSID auto-detected successfully!'
      : vaultDns
      ? `Domain detected (${vaultDns}), please enter SSID or sign in.`
      : 'No active *.veevavault.com tab found. Please enter Vault DNS and SSID manually!'
  };
}

async function verifyVaultSsid(rawDns, rawSsid) {
  const vaultDns = (rawDns || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '');
  const ssid = (rawSsid || '').trim();

  if (!vaultDns || !ssid) {
    throw new Error('Please provide both Vault DNS (e.g. myvault.veevavault.com) and SSID!');
  }

  let userName = 'Authenticated User';
  let userId = '';
  let vaultName = vaultDns;
  let apiVerified = false;

  try {
    const response = await fetch(`https://${vaultDns}/api/v24.1/objects/users/me`, {
      method: 'GET',
      headers: {
        Authorization: ssid,
        Accept: 'application/json'
      }
    });

    if (response.ok) {
      const data = await response.json();
      if (data.responseStatus === 'SUCCESS') {
        apiVerified = true;
        const u = data.users && data.users[0] && data.users[0].user;
        if (u) {
          userId = String(u.id || '');
          userName = `${u.user_first_name__v || ''} ${u.user_last_name__v || ''} (${u.user_name__v || ''})`.trim();
        }
      }
    }
  } catch (err) {
    console.warn('Vault API direct verification notice:', err.message);
  }

  const vaultSession = {
    connected: true,
    apiVerified,
    vaultDns,
    ssid,
    userName,
    userId,
    vaultName,
    lastVerified: new Date().toISOString()
  };

  await chrome.storage.local.set({ vaultSession });
  return {
    success: true,
    vaultSession,
    message: apiVerified
      ? `Connected to Veeva Vault API (Read-Only): ${userName}`
      : `SSID saved for ${vaultDns} (Read-Only mode)`
  };
}

async function loginWithCredentials(rawDns, username, password) {
  const vaultDns = (rawDns || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '');

  if (!vaultDns || !username || !password) {
    throw new Error('Vault DNS, username, and password are required!');
  }

  const body = new URLSearchParams();
  body.append('username', username.trim());
  body.append('password', password);

  const response = await fetch(`https://${vaultDns}/api/v24.1/auth`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: body.toString()
  });

  const data = await response.json();
  if (data.responseStatus !== 'SUCCESS' || !data.sessionId) {
    const errMsg =
      data.errors && data.errors[0]
        ? data.errors[0].message
        : 'Authentication failed (please verify your credentials).';
    throw new Error(errMsg);
  }

  return await verifyVaultSsid(vaultDns, data.sessionId);
}

async function detectActiveVaultContext() {
  const activeTab = await getTargetBrowserTab();
  let vaultDns = '';
  let currentObjectName = '';
  let pageUrl = activeTab?.url || '';

  if (pageUrl && pageUrl.startsWith('http')) {
    try {
      const parsed = new URL(pageUrl);
      vaultDns = parsed.hostname;
      const hashMatch = (parsed.hash || '').match(/[?&]t=([a-z0-9_]+__(?:v|c|rim|sys|cda))/i);
      if (hashMatch && hashMatch[1]) {
        currentObjectName = hashMatch[1].toLowerCase();
      }
    } catch (e) {}
  }

  if (!currentObjectName && activeTab && activeTab.id && pageUrl && !pageUrl.startsWith('chrome://')) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: () => {
          const hash = window.location.hash || '';
          const m = hash.match(/[?&]t=([a-z0-9_]+__(?:v|c|rim|sys|cda))/i);
          if (m && m[1]) return m[1].toLowerCase();
          const link = document.querySelector('a.objSchemaLink[href*="t="]');
          if (link) {
            const lm = (link.getAttribute('href') || '').match(
              /[?&]t=([a-z0-9_]+__(?:v|c|rim|sys|cda))/i
            );
            if (lm && lm[1]) return lm[1].toLowerCase();
          }
          return '';
        }
      });
      if (results && results[0] && results[0].result) {
        currentObjectName = results[0].result;
      }
    } catch (e) {}
  }

  const store = await chrome.storage.local.get(['vaultSession']);
  const session = store.vaultSession || {};
  if (!vaultDns && session.vaultDns) {
    vaultDns = session.vaultDns;
  }

  return {
    ok: true,
    success: true,
    vaultDns,
    objectName: currentObjectName,
    currentObjectName,
    pageUrl
  };
}

async function fetchAllVaultObjectsReadOnly(forceRefresh = false) {
  const ctx = await detectActiveVaultContext();
  const store = await chrome.storage.local.get(['vaultSession']);
  const session = store.vaultSession || {};
  let vaultDns = ctx.vaultDns || session.vaultDns || '';
  let ssid = session.ssid || '';

  if (!ssid || !vaultDns) {
    try {
      const detected = await autoDetectVaultSession(ctx.pageUrl);
      if (detected && detected.ssid) ssid = detected.ssid;
      if (detected && detected.vaultDns) vaultDns = detected.vaultDns;
    } catch (e) {}
  }

  if (!forceRefresh && vaultDns && allObjectsListCache.has(vaultDns)) {
    return {
      ok: true,
      success: true,
      vaultDns,
      objectName: ctx.currentObjectName,
      currentObjectName: ctx.currentObjectName,
      objects: allObjectsListCache.get(vaultDns)
    };
  }

  const apiVersions = ['v24.1', 'v23.3', 'v22.3'];
  if (vaultDns && ssid) {
    for (const ver of apiVersions) {
      try {
        const resp = await fetch(`https://${vaultDns}/api/${ver}/metadata/vobjects`, {
          method: 'GET',
          headers: {
            Authorization: ssid,
            Accept: 'application/json'
          }
        });
        if (!resp.ok) continue;
        const data = await resp.json();
        if (data.responseStatus === 'SUCCESS' && Array.isArray(data.objects)) {
          const objects = data.objects
            .map((o) => ({
              name: o.name || '',
              label: o.label || o.name || '',
              source: o.source || 'standard',
              status: Array.isArray(o.status) ? o.status[0] : o.status || 'Active'
            }))
            .filter((o) => o.name)
            .sort((a, b) => a.label.localeCompare(b.label));
          allObjectsListCache.set(vaultDns, objects);
          return {
            ok: true,
            success: true,
            vaultDns,
            objectName: ctx.currentObjectName,
            currentObjectName: ctx.currentObjectName,
            objects
          };
        }
      } catch (e) {}
    }
  }

  const activeTab = await getTargetBrowserTab();
  if (activeTab && activeTab.id && activeTab.url && !activeTab.url.startsWith('chrome://')) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: () => {
          const list = [];
          const seen = new Set();
          document.querySelectorAll('table.vv_gridview_table tbody tr').forEach((tr) => {
            const nameCell = tr.querySelector('td[data-column-name="name"]');
            const labelCell = tr.querySelector('td[data-column-name="label"]');
            const sourceCell = tr.querySelector('td[data-column-name="source"]');
            const name = (nameCell?.textContent || '').trim();
            const label = (labelCell?.textContent || '').trim() || name;
            const source = (sourceCell?.textContent || '').trim() || 'standard';
            if (name && !seen.has(name)) {
              seen.add(name);
              list.push({ name, label, source, status: 'Active' });
            }
          });
          return list;
        }
      });
      const domObjects = (results && results[0] && results[0].result) || [];
      if (domObjects.length > 0) {
        domObjects.sort((a, b) => a.label.localeCompare(b.label));
        return {
          ok: true,
          success: true,
          vaultDns,
          objectName: ctx.currentObjectName,
          currentObjectName: ctx.currentObjectName,
          objects: domObjects
        };
      }
    } catch (e) {}
  }

  return {
    ok: false,
    success: false,
    vaultDns,
    objectName: ctx.currentObjectName,
    currentObjectName: ctx.currentObjectName,
    objects: [],
    error: 'Connect SSID (click Auto-SSID) or open the Veeva Objects table to load object list.'
  };
}

async function queryAuditTrailChangesReadOnly(options = {}) {
  const hoursBack = Number(options.hoursBack || 2);
  const componentTypeFilter = (options.componentTypeFilter || '').trim().toLowerCase();
  const sinceIso = new Date(Date.now() - hoursBack * 3600 * 1000).toISOString();

  const store = await chrome.storage.local.get(['vaultSession']);
  const session = store.vaultSession || {};
  let vaultDns = session.vaultDns || '';
  let ssid = session.ssid || '';

  const activeTab = await getTargetBrowserTab();
  if ((!vaultDns || !ssid) && activeTab?.url) {
    try {
      const detected = await autoDetectVaultSession(activeTab.url);
      if (detected && detected.ssid) ssid = detected.ssid;
      if (detected && detected.vaultDns) vaultDns = detected.vaultDns;
    } catch (e) {}
  }

  const items = [];
  if (vaultDns && ssid) {
    try {
      const vql = `SELECT id, label__v, name__v, component_name__v, component_type__v, modified_date__v, created_date__v, status__v FROM vault_component__v WHERE modified_date__v >= '${sinceIso}' ORDER BY modified_date__v DESC MAXROWS 80`;
      const resp = await fetch(`https://${vaultDns}/api/v24.1/query?q=${encodeURIComponent(vql)}`, {
        method: 'GET',
        headers: {
          Authorization: ssid,
          Accept: 'application/json'
        }
      });
      if (resp.ok) {
        const json = await resp.json();
        if (json.responseStatus === 'SUCCESS' && Array.isArray(json.data)) {
          json.data.forEach((row) => {
            const compType = row.component_type__v || 'Component';
            if (componentTypeFilter && !compType.toLowerCase().includes(componentTypeFilter)) {
              return;
            }
            const compName = row.component_name__v || row.name__v || '';
            const compLabel = row.label__v || compName;
            items.push({
              componentType: compType,
              label: compLabel,
              name: compLabel,
              apiName: compName,
              componentName: compName,
              status: Array.isArray(row.status__v) ? row.status__v[0] : row.status__v || 'Active',
              modifiedDate: formatVeevaDateRange(row.modified_date__v, row.created_date__v)
            });
          });
        }
      }
    } catch (e) {}
  }

  return {
    ok: true,
    success: true,
    domain: vaultDns || 'Active Tab',
    items
  };
}

async function navigateActiveVaultTab(objectName, fieldName, subPage = 'fields', hashPath = '') {
  const activeTab = await getTargetBrowserTab();
  if (!activeTab || !activeTab.id) {
    return { ok: false, success: false, error: 'No active Veeva Vault tab found.' };
  }
  let targetHash = hashPath;
  if (!targetHash) {
    const cleanObj = (objectName || '').trim();
    if (!cleanObj) {
      return { ok: false, success: false, error: 'Missing object name.' };
    }
    const cleanField = (fieldName || '').trim();
    targetHash = cleanField
      ? `#admin/content_setup/object_schema/fields?t=${encodeURIComponent(
          cleanObj
        )}&d=${encodeURIComponent(cleanField)}`
      : `#admin/content_setup/object_schema/${subPage || 'fields'}?t=${encodeURIComponent(cleanObj)}`;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      func: (hashStr) => {
        window.location.hash = hashStr;
      },
      args: [targetHash]
    });
    return { ok: true, success: true, hash: targetHash };
  } catch (err) {
    return { ok: false, success: false, error: err.message };
  }
}

async function openInPageErdModalOnActiveTab(objectName) {
  const activeTab = await getTargetBrowserTab();
  if (!activeTab || !activeTab.id) {
    return { ok: false, success: false, error: 'No active Veeva Vault tab found.' };
  }
  try {
    await navigateActiveVaultTab(objectName, '', 'fields');
    return { ok: true, success: true };
  } catch (err) {
    return { ok: false, success: false, error: err.message };
  }
}
