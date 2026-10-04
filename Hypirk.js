//@name Hypirk
//@display-name Hypirk
//@api 3.0
//@version 0.1.6
//@update-url https://raw.githubusercontent.com/hhja37984-AI/Hypirk-release/main/Hypirk.js
// ============================================================================
// Hypirk — RP memory-management plugin
//
// MemoryEntry schema v3:
// - entries[] owns { memory: HypirkMemory | null, linkedMessages: number[] }.
// - memory.id is stable internal identity; dense memory numbers are computed only in the UI.
// - Memory text payload is content-only: time + content; structured dialogues are no longer stored.
// - messages is a chat-wide table: numeric reference slot -> { chatId, index, anchor }.
// - Reference slots are stable; record.index / UI numbers follow the current chat position.
// - Import without a messages table interprets linkedMessages as current chat indices.
// - Native state uses a separate v2 key.
//
// Design principles:
// - Keep Hypirk state isolated in its own storage keys.
// - Automatic summarization is the default; manual summarization remains an optional user action.
// - Memory cards are the primary UI; each entry owns its linked message references.
// - Hypirk owns its schema; external formats are normalized only at import boundaries.
// - LLM performs bounded summarization/translation work; plugin/user manage system state.
// ============================================================================
(async () => {
    // ── Types ────────────────────────────────────────────────────────────────
    // ── Constants ────────────────────────────────────────────────────────────
    const PROMPT_STORAGE_KEY = "hypirkproto_prompt";
    const SETTINGS_STORAGE_KEY = "HypirkProto_settings";
    const CHARACTER_TIMELINE_SETTINGS_PREFIX = "hypirkproto_character_timeline:";
    const PRESETS_STORAGE_KEY = "hypirkproto_presets";
    const MEMORY_INJECTION_PROFILES_STORAGE_KEY = "hypirkproto_memory_injection_profiles_v1";
    const REGEX_LIBRARY_STORAGE_KEY = "hypirkproto_regex_library_v1";
    const REGEX_DEFAULTS_VERSION_KEY = "hypirkproto_regex_defaults_version";
    const REGEX_DEFAULTS_VERSION = 1;
    const DISTRIBUTION_VERSION_LABEL = "Hypirk 0.1.6";
    const HYPIRK_ICON_SVG = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path d="M8 21V3M15 21V3C17.2091 3 19 4.79086 19 7V9C19 11.2091 17.2091 13 15 13M11 3V8C11 9.65685 9.65685 11 8 11C6.34315 11 5 9.65685 5 8V3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    const DEFAULT_NODE_TRANSLATION_PROMPT = `Translate the supplied Hypirk memory content into the requested target language.
Preserve all meaning, ambiguity, names, formatting, paragraph order, dialogue speaker names, and quoted dialogue.
Do not summarize, embellish, censor, explain, or add information.
Return JSON only in this exact shape:
{"content":"translated content"}`;
    const DEFAULT_CHUNK_SIZE = 30;
    const DEFAULT_RETAINED_MESSAGES_AFTER_SUMMARY = 20;
    const DEFAULT_MAX_MEMORY_TOKENS = 20000;
    const DEFAULT_MEMORY_INJECTION_ANCHOR = "";
    const DEFAULT_MEMORY_INJECTION_TEMPLATE = "{{hypa}}";
    const DEFAULT_MEMORY_SEPARATOR = "\\n";
    const DEFAULT_LOREBOOK_SEPARATOR = "\\n\\n";
    const DEFAULT_MAX_LOREBOOK_TOKENS = 4000;
    const HYPA_CONTEXT_PLACEHOLDER = "{{hypa}}";
    const CHOSEN_CONTEXT_PLACEHOLDER = "{{chosen}}";
    // Deliberately one closing brace. Native Risu {{position::X}} placeholders
    // can be consumed before beforeRequest; this near-CBS marker survives for Hypirk.
    const LOREBOOK_POSITION_PLACEHOLDER_PATTERN = /\{\{position::([^{}\r\n]+)\}(?!\})/g;
    const LOREBOOK_POSITION_DECORATOR_PATTERN = /^[ \t]*@@position[ \t]+pt_([^\s]+)[ \t]*$/gm;
    const LOREBOOK_DECORATOR_LINE_PATTERN = /^[ \t]*@@[^\r\n]*(?:\r?\n|$)/gm;
    const DEFAULT_RECENT_MEMORY_RATIO = 0.5;
    const EMBEDDING_BATCH_TOKEN_LIMIT = 80000;
    const DEFAULT_LIKE_BONUS_BASE = 0.08;
    const LIKE_DECAY_MS = 4 * 24 * 60 * 60 * 1000;
    const DEFAULT_DIALOGUE_LOCAL_WEIGHT = 0.06;
    const DEFAULT_DIALOGUE_EMBEDDING_WEIGHT = 0.08;
    const DEFAULT_ACTIVATION_CUE_WEIGHT = 0.06;
    const RETRIEVAL_HISTORY_TOP_N = 30;
    const NODE_EMBEDDING_SCHEMA_VERSION = 4;
    const LOREBOOK_EMBEDDING_SCHEMA_VERSION = 1;
    const DEFAULT_EVENT_FORMAT = "Time: [[time]]\n[[content]]";
    function normalizeContentOnlyEventFormat(value) {
        const lines = String(value ?? "").replace(/\r\n?/g, "\n").split("\n");
        const cleaned = lines.filter((line) => !line.includes("[[dialogues]]")).join("\n").trim();
        return cleaned || DEFAULT_EVENT_FORMAT;
    }
    function normalizeRetrievalWeight(value, fallback) {
        const parsed = typeof value === "number" ? value : Number(value);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
    }
    const NEW_PRESET_SUMMARY_PROMPT = "";
    const NEW_PRESET_CHUNK_SIZE = 6;
    const NEW_PRESET_RETAINED_MESSAGES_AFTER_SUMMARY = 20;
    const NEW_PRESET_EMBEDDING_CONTEXT_MESSAGES = 3;
    const NEW_PRESET_MEMORY_SEPARATOR = "\\n\\n";
    const NEW_PRESET_MAX_MEMORY_TOKENS = 10000;
    const NEW_PRESET_RECENT_MEMORY_RATIO = 0.5;
    const NEW_PRESET_EVENT_FORMAT = "Date: [[time]]\n[[content]]";
        const UI_ROLE_PALETTE_DEFAULTS = {
        "--hp-radius-none": "0",
        "--hp-radius-swatch": "1.5px",
        "--hp-radius-xs": "2.1px",
        "--hp-radius-sm": "2.8px",
        "--hp-radius-md": "3.5px",
        "--hp-radius-lg": "4.2px",
        "--hp-radius-card": "5.6px",
        "--hp-radius-modal": "8.4px",
        "--hp-radius-pill": "16.8px",
        "--hp-radius-circle": "50%",
        "--hp-top-tabs-background": "transparent",
        "--hp-top-tab-text": "var(--hp-text-muted)",
        "--hp-top-tab-hover-text": "var(--hp-text-strong)",
        "--hp-panel": "var(--hp-surface)",
        "--hp-similar-color": "#134528",
        "--hp-recent-color": "#1e326f",
        "--hp-similar-opacity": "10%",
        "--hp-recent-opacity": "10%",
        "--hp-similar-stat-opacity": "12%",
        "--hp-recent-ring-opacity": "20%",
        "--hp-similar-overlay": "color-mix(in srgb, var(--hp-similar-color) var(--hp-similar-opacity), transparent)",
        "--hp-similar-stat-overlay": "color-mix(in srgb, var(--hp-similar-color) var(--hp-similar-stat-opacity), transparent)",
        "--hp-recent-overlay": "color-mix(in srgb, var(--hp-recent-color) var(--hp-recent-opacity), transparent)",
        "--hp-recent-ring": "color-mix(in srgb, var(--hp-recent-color) var(--hp-recent-ring-opacity), transparent)",
        "--hp-similar-badge-background": "var(--hp-similar-color)",
        "--hp-similar-badge-text": "#e8f8ed",
        "--hp-recent-badge-background": "var(--hp-recent-color)",
        "--hp-recent-badge-text": "#e7edff",
        "--hp-node-edit-text": "var(--hp-text-control)",
        "--hp-popup-save-background": "var(--hp-primary)",
        "--hp-popup-save-hover-background": "var(--hp-primary-hover)",
        "--hp-popup-save-text": "var(--hp-text-on-color)",
        "--hp-popup-save-border": "transparent",
        "--hp-dialogue-speaker": "var(--hp-facts-text)",
        "--hp-similarity-text": "var(--hp-event-text)",
        "--hp-manual-summary-background": "var(--hp-primary)",
        "--hp-manual-summary-hover-background": "var(--hp-primary-hover)",
        "--hp-manual-summary-text": "var(--hp-text-on-color)",
        "--hp-manual-node-background": "var(--hp-facts)",
        "--hp-manual-node-hover-background": "var(--hp-facts)",
        "--hp-manual-node-text": "var(--hp-facts-text)",
    };
    const GRAPHITE_UI_PALETTE = {
        "--hp-color-scheme": "dark",
        "--hp-page-backdrop": "rgba(4, 5, 6, 0.78)",
        "--hp-background": "#17191b",
        "--hp-surface": "#202326",
        "--hp-inset": "#2a2e32",
        "--hp-border": "#454a50",
        "--hp-control-border": "#747b83",
        "--hp-primary": "#69737d",
        "--hp-primary-hover": "#59636d",
        "--hp-secondary": "#30353a",
        "--hp-secondary-hover": "#41474d",
        "--hp-danger": "#915b62",
        "--hp-danger-hover": "#7e4c53",
        "--hp-event": "#858c93",
        "--hp-facts": "#70777e",
        "--hp-favorite": "#c58c92",
        "--hp-text": "#e4e7ea",
        "--hp-text-muted": "#a7adb4",
        "--hp-text-strong": "#f5f6f7",
        "--hp-text-control": "#d4d8dc",
        "--hp-text-on-color": "#ffffff",
        "--hp-event-text": "#cbd0d5",
        "--hp-facts-text": "#b8bec4",
        "--hp-dialogue-speaker": "#bcc2c8",
        "--hp-similar-badge-background": "color-mix(in srgb, var(--hp-similar-color) 80%, transparent)",
        "--hp-recent-badge-background": "color-mix(in srgb, var(--hp-recent-color) 80%, transparent)",
        "--hp-manual-node-background": "#555e67",
        "--hp-manual-node-hover-background": "#69737d",
        "--hp-manual-node-text": "#ffffff",
    };
    const IVORY_UI_PALETTE = {
        "--hp-color-scheme": "light",
        "--hp-page-backdrop": "rgba(24, 27, 30, 0.52)",
        "--hp-background": "#f4f3ef",
        "--hp-surface": "#fffefa",
        "--hp-inset": "#e8e9e5",
        "--hp-border": "#c9ccc8",
        "--hp-control-border": "#767b80",
        "--hp-primary": "#4f6575",
        "--hp-primary-hover": "#3d5261",
        "--hp-secondary": "#d8dde0",
        "--hp-secondary-hover": "#c2c9ce",
        "--hp-danger": "#9b5057",
        "--hp-danger-hover": "#843f46",
        "--hp-event": "#496b72",
        "--hp-facts": "#756270",
        "--hp-favorite": "#9b5057",
        "--hp-text": "#25282b",
        "--hp-text-muted": "#62676c",
        "--hp-text-strong": "#304957",
        "--hp-text-control": "#30363b",
        "--hp-text-on-color": "#ffffff",
        "--hp-event-text": "#315a61",
        "--hp-facts-text": "#684f60",
        "--hp-dialogue-speaker": "#496b72",
        "--hp-manual-node-background": "#756270",
        "--hp-manual-node-hover-background": "#624f5c",
        "--hp-manual-node-text": "#ffffff",
    };
    const KITTY_CLASSIC_UI_PALETTE = {
        "--hp-color-scheme": "light",
        "--hp-page-backdrop": "rgba(34, 30, 31, 0.48)",
        "--hp-background": "#f8f3ee",
        "--hp-surface": "#fffdfa",
        "--hp-inset": "#f1e8e1",
        "--hp-border": "#dbcfc5",
        "--hp-control-border": "#8f837b",
        "--hp-primary": "#d9414e",
        "--hp-primary-hover": "#c53542",
        "--hp-secondary": "#f1e8e1",
        "--hp-secondary-hover": "#e7dad1",
        "--hp-danger": "#a1444d",
        "--hp-danger-hover": "#8f3740",
        "--hp-event": "#3d74d8",
        "--hp-facts": "#f1cb3d",
        "--hp-favorite": "#d9414e",
        "--hp-text": "#30292a",
        "--hp-text-muted": "#726767",
        "--hp-text-strong": "#6d3a41",
        "--hp-text-control": "#30292a",
        "--hp-text-on-color": "#ffffff",
        "--hp-event-text": "#f6fbff",
        "--hp-facts-text": "#4b3900",
        "--hp-dialogue-speaker": "#3d74d8",
        "--hp-manual-node-background": "#3d74d8",
        "--hp-manual-node-hover-background": "#305fb8",
        "--hp-manual-node-text": "#ffffff",
    };
    const CATPPUCCIN_LATTE_UI_PALETTE = {
        "--hp-color-scheme": "light",
        "--hp-page-backdrop": "rgba(31, 34, 48, 0.40)",
        "--hp-background": "#eff1f5",
        "--hp-surface": "#f7ecea",
        "--hp-inset": "#e5ecf6",
        "--hp-border": "#c7c9d3",
        "--hp-control-border": "#7f849c",
        "--hp-primary": "#1e66f5",
        "--hp-primary-hover": "#1857d5",
        "--hp-secondary": "#e6e9ef",
        "--hp-secondary-hover": "#d8dce6",
        "--hp-danger": "#d20f39",
        "--hp-danger-hover": "#b30c30",
        "--hp-favorite": "#8839ef",
        "--hp-text": "#303446",
        "--hp-text-muted": "#686c82",
        "--hp-text-strong": "#4c4f69",
        "--hp-text-control": "#43465a",
        "--hp-text-on-color": "#ffffff",
        "--hp-dialogue-speaker": "#1e66f5",
        "--hp-similarity-text": "#209fb5",
        "--hp-manual-node-background": "#8839ef",
        "--hp-manual-node-hover-background": "#7330ce",
        "--hp-manual-node-text": "#ffffff",
    };
    const COCOA_NIGHT_UI_PALETTE = {
        "--hp-color-scheme": "dark",
        "--hp-page-backdrop": "rgba(7, 5, 4, 0.80)",
        "--hp-background": "#1b1715",
        "--hp-surface": "#251f1c",
        "--hp-inset": "#312926",
        "--hp-border": "#3a302b",
        "--hp-control-border": "#4b403a",
        "--hp-primary": "#815b49",
        "--hp-primary-hover": "#6d4a3b",
        "--hp-secondary": "#3a302b",
        "--hp-secondary-hover": "#4a3c36",
        "--hp-danger": "#92505b",
        "--hp-danger-hover": "#7b404b",
        "--hp-favorite": "#a86573",
        "--hp-text": "#d8cdc6",
        "--hp-text-muted": "#a8978f",
        "--hp-text-strong": "#e4d9d2",
        "--hp-text-control": "#c8bbb3",
        "--hp-text-on-color": "#e8ded8",
        "--hp-dialogue-speaker": "#a8b9c8",
        "--hp-similarity-text": "#a8b9c8",
        "--hp-manual-node-background": "#4b403a",
        "--hp-manual-node-hover-background": "#815b49",
        "--hp-manual-node-text": "#e8ded8",
    };
    const CHERRY_BUTTER_UI_PALETTE = {
        "--hp-color-scheme": "light",
        "--hp-page-backdrop": "rgba(47, 35, 39, 0.42)",
        "--hp-background": "#ebe0de",
        "--hp-surface": "#fffcf4",
        "--hp-inset": "#eeefed",
        "--hp-border": "#c0c2c1",
        "--hp-control-border": "#6a555c",
        "--hp-primary": "#6c0e15",
        "--hp-primary-hover": "#570b10",
        "--hp-secondary": "#eae9d6",
        "--hp-secondary-hover": "#dbd9c4",
        "--hp-danger": "#963a43",
        "--hp-danger-hover": "#7d2e36",
        "--hp-favorite": "#8a3f62",
        "--hp-text": "#2a2227",
        "--hp-text-muted": "#525a56",
        "--hp-text-strong": "#372930",
        "--hp-text-control": "#33292e",
        "--hp-text-on-color": "#f5ece7",
        "--hp-dialogue-speaker": "#6c0e15",
        "--hp-similarity-text": "#6a555c",
        "--hp-manual-node-background": "#f2e0a0",
        "--hp-manual-node-hover-background": "#e4cf83",
        "--hp-manual-node-text": "#4c3b0f",
    };
    const TAILORED_FIRST_CRUSH_UI_PALETTE = {
        "--hp-color-scheme": "dark",
        "--hp-page-backdrop": "rgba(7, 7, 8, 0.80)",
        "--hp-background": "#1e1e1f",
        "--hp-surface": "#474243",
        "--hp-inset": "#28393c",
        "--hp-border": "#28393c",
        "--hp-control-border": "#435559",
        "--hp-primary": "#5c5453",
        "--hp-primary-hover": "#6d6261",
        "--hp-secondary": "#5d585a",
        "--hp-secondary-hover": "#6a6466",
        "--hp-danger": "#8f565c",
        "--hp-danger-hover": "#a16066",
        "--hp-favorite": "#ac6f6f",
        "--hp-text": "#d2c7c4",
        "--hp-text-muted": "#a99f9f",
        "--hp-text-strong": "#e1d8d4",
        "--hp-text-control": "#c5bbb8",
        "--hp-text-on-color": "#e8dedb",
        "--hp-dialogue-speaker": "#a8b7ad",
        "--hp-similarity-text": "#a8b7ad",
        "--hp-manual-node-background": "#ac6f6f",
        "--hp-manual-node-hover-background": "#98605f",
        "--hp-manual-node-text": "#111214",
    };
    const UI_PALETTES = {
        graphite: GRAPHITE_UI_PALETTE,
        ivory: IVORY_UI_PALETTE,
        kitty_classic: KITTY_CLASSIC_UI_PALETTE,
        catppuccin_latte: CATPPUCCIN_LATTE_UI_PALETTE,
        cocoa_night: COCOA_NIGHT_UI_PALETTE,
        cherry_butter: CHERRY_BUTTER_UI_PALETTE,
        tailored_first_crush: TAILORED_FIRST_CRUSH_UI_PALETTE,
    };
    const UI_COLOR_PRESET_OPTIONS = [
        {
            value: "graphite",
            label: "Graphite",
            swatches: ["#17191b", "#202326", "#2a2e32", "#134528", "#1e326f"],
        },
        {
            value: "ivory",
            label: "Ivory",
            swatches: ["#f4f3ef", "#fffefa", "#e8e9e5", "#4f6575", "#25282b"],
        },
        {
            value: "kitty_classic",
            label: "Kitty Classic",
            swatches: ["#f8f3ee", "#fffdfa", "#d9414e", "#3d74d8", "#f1cb3d"],
        },
        {
            value: "catppuccin_latte",
            label: "Catppuccin Latte",
            swatches: ["#eff1f5", "#f7ecea", "#e5ecf6", "#1e66f5", "#8839ef"],
        },
        {
            value: "cocoa_night",
            label: "Cocoa Night",
            swatches: ["#1b1715", "#251f1c", "#312926", "#815b49", "#a86573"],
        },
        {
            value: "cherry_butter",
            label: "Cherry Butter",
            swatches: ["#ebe0de", "#fffcf4", "#eeefed", "#6c0e15", "#f2e0a0"],
        },
        {
            value: "tailored_first_crush",
            label: "Tailored First Crush",
            swatches: ["#1e1e1f", "#474243", "#28393c", "#5c5453", "#ac6f6f"],
        },
    ];
    function isUiColorPreset(value) {
        return typeof value === "string" && value in UI_PALETTES;
    }
    function renderUiColorPresetSwatches(option) {
        return `<span class="hp-theme-swatches" aria-hidden="true">${option.swatches
            .map((color) => `<span class="hp-theme-swatch" style="--hp-theme-swatch:${color};"></span>`)
            .join("")}</span>`;
    }
    function renderUiMenuCheck(selected) {
        return `<span class="hp-ui-menu-check" aria-hidden="true">${selected ? "✓" : ""}</span>`;
    }
    function renderUiMenu() {
        const graphite = UI_COLOR_PRESET_OPTIONS.find((option) => option.value === "graphite");
        const ivory = UI_COLOR_PRESET_OPTIONS.find((option) => option.value === "ivory");
        const expandedOptions = UI_COLOR_PRESET_OPTIONS.filter((option) => option.value !== "graphite" && option.value !== "ivory");
        const expandedCurrent = expandedOptions.find((option) => option.value === uiColorPreset);
        return `
      <div class="hp-ui-menu" id="hp-ui-menu">
        <button class="hp-ui-menu-button" id="hp-ui-menu-button" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="hp-ui-menu-root">
          <span>UI</span><span class="hp-ui-menu-chevron" aria-hidden="true"></span>
        </button>
        <div class="hp-ui-menu-root" id="hp-ui-menu-root" role="menu" aria-label="UI 설정" hidden>
          <button class="hp-ui-menu-item" type="button" role="menuitemradio" data-ui-color-preset="graphite" aria-checked="${uiColorPreset === "graphite"}">
            <span>${escapeHtml(graphite.label)}</span>${renderUiColorPresetSwatches(graphite)}${renderUiMenuCheck(uiColorPreset === "graphite")}
          </button>
          <button class="hp-ui-menu-item" type="button" role="menuitemradio" data-ui-color-preset="ivory" aria-checked="${uiColorPreset === "ivory"}">
            <span>${escapeHtml(ivory.label)}</span>${renderUiColorPresetSwatches(ivory)}${renderUiMenuCheck(uiColorPreset === "ivory")}
          </button>
          <div class="hp-ui-submenu">
            <button class="hp-ui-menu-item hp-ui-submenu-trigger" type="button" role="menuitem" aria-haspopup="menu" aria-expanded="false" aria-controls="hp-ui-submenu-expanded-color">
              <span>expanded color</span><span class="hp-ui-menu-current">${expandedCurrent ? escapeHtml(expandedCurrent.label) : ""}</span><span class="hp-ui-submenu-arrow" aria-hidden="true">›</span>
            </button>
            <div class="hp-ui-submenu-panel" id="hp-ui-submenu-expanded-color" role="menu" aria-label="확장 색상" hidden>
              ${expandedOptions.map((option) => `<button class="hp-ui-menu-item" type="button" role="menuitemradio" data-ui-color-preset="${option.value}" aria-checked="${uiColorPreset === option.value}"><span>${escapeHtml(option.label)}</span>${renderUiColorPresetSwatches(option)}${renderUiMenuCheck(uiColorPreset === option.value)}</button>`).join("")}
            </div>
          </div>
          <div class="hp-ui-submenu">
            <button class="hp-ui-menu-item hp-ui-submenu-trigger" type="button" role="menuitem" aria-haspopup="menu" aria-expanded="false" aria-controls="hp-ui-submenu-reading-scale">
              <span>글자 크기</span><span class="hp-ui-menu-current">${readingScale.toFixed(1)}</span><span class="hp-ui-submenu-arrow" aria-hidden="true">›</span>
            </button>
            <div class="hp-ui-submenu-panel" id="hp-ui-submenu-reading-scale" role="menu" aria-label="글자 크기" hidden>
              ${READING_SCALE_PRESETS.map((scale) => `<button class="hp-ui-menu-item" type="button" role="menuitemradio" data-ui-reading-scale="${scale}" aria-checked="${readingScale === scale}"><span>${scale.toFixed(1)}</span>${renderUiMenuCheck(readingScale === scale)}</button>`).join("")}
            </div>
          </div>
          <div class="hp-ui-submenu">
            <button class="hp-ui-menu-item hp-ui-submenu-trigger" type="button" role="menuitem" aria-haspopup="menu" aria-expanded="false" aria-controls="hp-ui-submenu-reading-font">
              <span>글꼴</span><span class="hp-ui-menu-current">${READING_FONT_OPTIONS.find((option) => option.value === readingFontFamily)?.label ?? "고딕"}</span><span class="hp-ui-submenu-arrow" aria-hidden="true">›</span>
            </button>
            <div class="hp-ui-submenu-panel" id="hp-ui-submenu-reading-font" role="menu" aria-label="글꼴" hidden>
              ${READING_FONT_OPTIONS.map((option) => `<button class="hp-ui-menu-item hp-ui-font-option hp-ui-font-${option.value}" type="button" role="menuitemradio" data-ui-reading-font="${option.value}" aria-checked="${readingFontFamily === option.value}"><span>${escapeHtml(option.label)}</span>${renderUiMenuCheck(readingFontFamily === option.value)}</button>`).join("")}
            </div>
          </div>
        </div>
      </div>`;
    }
    function renderDataManagementMenu() {
        return `
      <div class="hp-ui-menu hp-data-menu" id="hp-data-menu">
        <button class="hp-ui-menu-button hp-data-menu-button" id="hp-data-menu-button" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="hp-data-menu-root">
          <span>데이터 관리</span><span class="hp-ui-menu-chevron" aria-hidden="true"></span>
        </button>
        <div class="hp-ui-menu-root hp-data-menu-root" id="hp-data-menu-root" role="menu" aria-label="데이터 관리" hidden>
          <button class="hp-ui-menu-item hp-data-menu-item" id="hp-backup-download" type="button" role="menuitem">
            <span>기억 내보내기</span><span class="material-symbols-outlined" aria-hidden="true">download</span>
          </button>
          <button class="hp-ui-menu-item hp-data-menu-item" id="hp-backup-restore" type="button" role="menuitem">
            <span>기억 불러오기</span><span class="material-symbols-outlined" aria-hidden="true">move_to_inbox</span>
          </button>
          <button class="hp-ui-menu-item hp-data-menu-item" id="hp-import-hypav3-data" type="button" role="menuitem">
            <span>HypaV3 가져오기</span><span class="material-symbols-outlined" aria-hidden="true">move_up</span>
          </button>
          <div class="hp-ui-submenu">
            <button class="hp-ui-menu-item hp-ui-submenu-trigger hp-data-submenu-trigger" type="button" role="menuitem" aria-haspopup="menu" aria-expanded="false" aria-controls="hp-data-submenu-memory-remove">
              <span>기억 제거</span><span class="hp-ui-submenu-arrow" aria-hidden="true">›</span>
            </button>
            <div class="hp-ui-submenu-panel hp-data-submenu-panel" id="hp-data-submenu-memory-remove" role="menu" aria-label="기억 제거" hidden>
              <button class="hp-ui-menu-item hp-data-menu-item hp-menu-danger" id="hp-clear-memory2" type="button" role="menuitem">
                <span>모든 기억 제거</span><span class="material-symbols-outlined" aria-hidden="true">delete_forever</span>
              </button>
            </div>
          </div>
          <input type="file" id="hp-restore-file" accept=".json" hidden>
        </div>
      </div>`;
    }
    function renderToolsMenu() {
        const summaryBusy = manualSummarizationInProgress || isSummarizing;
        return `
      <div class="hp-ui-menu hp-tools-menu" id="hp-tools-menu">
        <button class="hp-ui-menu-button hp-tools-menu-button" id="hp-tools-menu-button" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="hp-tools-menu-root">
          <span>도구</span><span class="hp-ui-menu-chevron" aria-hidden="true"></span>
        </button>
        <div class="hp-ui-menu-root hp-tools-menu-root" id="hp-tools-menu-root" role="menu" aria-label="도구" hidden>
          <button class="hp-ui-menu-item hp-tools-menu-item" id="hp-force-summarize" type="button" role="menuitem" ${summaryBusy ? "disabled" : ""}>
            <span>${summaryBusy ? "요약 중…" : "수동 요약"}</span><span class="material-symbols-outlined" aria-hidden="true">person_edit</span>
          </button>
          <button class="hp-ui-menu-item hp-tools-menu-item" id="hp-edit-entries" type="button" role="menuitem">
            <span>엔트리 편집</span><span class="material-symbols-outlined" aria-hidden="true">split_scene_2</span>
          </button>
          <button class="hp-ui-menu-item hp-tools-menu-item" id="hp-test-embedding" type="button" role="menuitem">
            <span>임베딩 테스트</span><span class="material-symbols-outlined" aria-hidden="true">experiment</span>
          </button>
          <div class="hp-ui-submenu">
            <button class="hp-ui-menu-item hp-ui-submenu-trigger hp-tools-submenu-trigger" type="button" role="menuitem" aria-haspopup="menu" aria-expanded="false" aria-controls="hp-tools-submenu-debug">
              <span>디버그 도구</span><span class="hp-ui-submenu-arrow" aria-hidden="true">›</span>
            </button>
            <div class="hp-ui-submenu-panel hp-tools-submenu-panel" id="hp-tools-submenu-debug" role="menu" aria-label="디버그 도구" hidden>
              <label class="hp-ui-menu-item hp-debug-menu-toggle" role="menuitemcheckbox" aria-checked="${debugMode}">
                <span>디버깅 모드</span><input type="checkbox" id="hp-debug-mode" ${debugMode ? "checked" : ""}>
              </label>
              <button class="hp-ui-menu-item hp-tools-menu-item" id="hp-export-retrieval-debug" type="button" role="menuitem"><span>Retrieval History JSON 내보내기</span><span class="material-symbols-outlined" aria-hidden="true">download</span></button>
              <button class="hp-ui-menu-item hp-tools-menu-item" id="hp-clear-node-embedding-cache" type="button" role="menuitem"><span>임베딩 캐시 초기화</span></button>
              <button class="hp-ui-menu-item hp-tools-menu-item" id="hp-copy-setfullchat-debug" type="button" role="menuitem"><span>setFullChat 로그 복사</span></button>
              <button class="hp-ui-menu-item hp-tools-menu-item" id="hp-view-storage-data" type="button" role="menuitem"><span>저장 데이터 보기</span></button>
            </div>
          </div>
        </div>
      </div>`;
    }
    function getUiPaletteCssVariables() {
        const palette = {
            ...UI_ROLE_PALETTE_DEFAULTS,
            ...UI_PALETTES[uiColorPreset],
        };
        return Object.entries(palette)
            .map(([name, value]) => `${name}:${value};`)
            .join("");
    }
    function ensureMaterialSymbolsFont() {
        if (!document.getElementById("hypirk-material-symbols")) {
            const link = document.createElement("link");
            link.id = "hypirk-material-symbols";
            link.rel = "stylesheet";
            link.href =
                "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&icon_names=autorenew,bolt,book_5,cached,check_circle,close,delete,delete_forever,deployed_code,download,edit,experiment,favorite,foggy,help,hourglass_top,list_arrow,lists,menu,move_to_inbox,move_up,note_add,partly_cloudy_day,person_edit,split_scene_2,star,sync_disabled,wand_stars&display=block";
            document.head.appendChild(link);
        }
    }
    function getStorageKey(charId, chatId) {
        return `hypirkproto_entries_v2_${charId}_${chatId}`;
    }
    const LOCAL_EMBEDDING_CACHE_PREFIX = "hypirkproto_embedding_cache_v1_";
    const LOCAL_LOREBOOK_EMBEDDING_CACHE_PREFIX = "hypirkproto_lorebook_embedding_cache_v1_";
    // Compact retrieval ledger. Stored as positional strings in pluginStorage.
    // v1 fields (pipe-delimited):
    //  0 version, 1 wall-clock ms, 2 character(id~name), 3 chat(id~name), 4 node id,
    //  5 source(R=Recent,S=Similar), 6 rank, 7 selected, 8 query count,
    //  9 detected Calendar day(raw), 10 memory age in Calendar days,
    // 11 Content score, 12 semantic Dialogue score, 13 semantic Dialogue contribution,
    // 14 lexical Dialogue score, 15 lexical Dialogue contribution,
    // 16 Activation score, 17 Activation contribution, 18 Like bonus, 19 total score,
    // 20 semantic Dialogue weight, 21 lexical Dialogue weight, 22 Activation weight,
    // 23 Like base weight. A dash means not applicable/unavailable.
    const COMPACT_RETRIEVAL_LEDGER_KEY = "hypirkproto_retrieval_ledger_v1";
    const COMPACT_RETRIEVAL_LEDGER_VERSION = "v1";
    const COMPACT_RETRIEVAL_HISTORY_PER_NODE = 20;
    const COMPACT_RETRIEVAL_LEDGER_MAX_ROWS = 5000;
    // Memory-token budgeting uses the o200k_base path verified by the standalone
    // Tokenizer Probe: device-local rank payload + js-tiktoken/lite. The large
    // rank payload is kept out of the plugin source and cached separately.
    const LOCAL_O200K_TOKENIZER_KEY = "hypirkproto_tokenizer_o200k_base_v2";
    const O200K_TOKENIZER_DATA_URL = "https://tiktoken.pages.dev/js/o200k_base.json";
    const JS_TIKTOKEN_VERSION = "1.0.21";
    const JS_TIKTOKEN_LITE_URL = `https://esm.sh/js-tiktoken@${JS_TIKTOKEN_VERSION}/lite`;
    const JS_TIKTOKEN_RANKS_URL = `https://esm.sh/js-tiktoken@${JS_TIKTOKEN_VERSION}/ranks/o200k_base`;
    const LOCAL_DERIVED_CACHE_PREFIX = "hypirkproto_derived_cache_v1_";
    function getLocalDerivedCacheKey(charId, chatId) {
        return `${LOCAL_DERIVED_CACHE_PREFIX}${encodeURIComponent(charId)}::${encodeURIComponent(chatId)}`;
    }
    function getLocalEmbeddingCacheKey(charId, chatId) {
        return `${LOCAL_EMBEDDING_CACHE_PREFIX}${encodeURIComponent(charId)}::${encodeURIComponent(chatId)}`;
    }
    function getLocalLorebookEmbeddingCacheKey(charId, chatId) {
        return `${LOCAL_LOREBOOK_EMBEDDING_CACHE_PREFIX}${encodeURIComponent(charId)}::${encodeURIComponent(chatId)}`;
    }
    const DEFAULT_SUMMARY_PROMPT = "";
    // ── State ────────────────────────────────────────────────────────────────
    function createEmptyState() {
        return {
            format: "hypirk",
            schemaVersion: 3,
            entries: [],
            messages: {},
            lastNodeScores: {},
            lastChosenNodeIds: [],
            lastRecentNodeIds: [],
            regexRuleIds: [],
            summarizerNote: "",
            hashRecoveryEnabled: false,
            translationViewCache: {},
            translationVisibleNodeIds: [],
            autoSummaryPending: false,
        };
    }
    let state = createEmptyState();
    let stateLoadFailed = false;
    let localEmbeddingStorage;
    let localEmbeddingCacheDirty = false;
    let localDerivedCacheDirty = false;
    let localEmbeddingCacheRevision = 0;
    let localDerivedCacheRevision = 0;
    function markEmbeddingCacheDirty() {
        localEmbeddingCacheDirty = true;
        localEmbeddingCacheRevision += 1;
    }
    function markDerivedCacheDirty() {
        localDerivedCacheDirty = true;
        localDerivedCacheRevision += 1;
    }
    let compactRetrievalLedger = [];
    let compactRetrievalLedgerLoaded = false;
    /** Last in-memory search trace. Deliberately excluded from plugin state and backups. */
    let lastEmbeddingRetrievalTrace = null;
    let currentCharIndex = -1;
    let currentChatIndex = -1;
    let currentCharId = "";
    let currentChatId = "";
    let detectedChatUiMetadata = null;
    function getDetectedChatUiMetadataForCurrentContext() {
        const metadata = detectedChatUiMetadata;
        if (!metadata ||
            metadata.charIndex !== currentCharIndex ||
            metadata.chatIndex !== currentChatIndex ||
            metadata.charId !== currentCharId ||
            metadata.chatId !== currentChatId) {
            return null;
        }
        return metadata;
    }
    function refreshStateOwnerNames(charId, chatId) {
        const metadata = detectedChatUiMetadata;
        if (!metadata || metadata.charId !== charId || metadata.chatId !== chatId)
            return false;
        let changed = false;
        if (state.ownerCharName !== metadata.charName) {
            state.ownerCharName = metadata.charName;
            changed = true;
        }
        if (state.ownerChatName !== metadata.chatName) {
            state.ownerChatName = metadata.chatName;
            changed = true;
        }
        return changed;
    }
    function resolveFirstMessageFromCharacterAndChat(char, chat) {
        let text = null;
        const fmIndex = Number(chat?.fmIndex);
        const fmIndexNum = Number.isNaN(fmIndex) ? -1 : fmIndex;
        if (fmIndexNum >= 0 &&
            Array.isArray(char?.alternateGreetings) &&
            char.alternateGreetings[fmIndexNum] !== undefined) {
            text = char.alternateGreetings[fmIndexNum].toString();
        }
        else if (char?.firstMessage !== undefined) {
            text = char.firstMessage.toString();
        }
        return {
            message: text !== null ? { role: "char", content: text } : null,
            alternateGreetingSelected: fmIndexNum >= 0,
        };
    }
    // ── Compact retrieval ledger ─────────────────────────────────────────────
    function compactLedgerField(value) {
        if (value === null || value === undefined || value === "")
            return "-";
        if (typeof value === "number")
            return Number.isFinite(value) ? String(value) : "-";
        return encodeURIComponent(String(value));
    }
    function compactLedgerIdentity(id, name) {
        return `${encodeURIComponent(id)}~${encodeURIComponent(name)}`;
    }
    function compactLedgerNumber(value, digits = 6) {
        const number = Number(value);
        if (!Number.isFinite(number))
            return "-";
        return Number(number.toFixed(digits)).toString();
    }
    function parseCompactLedgerNumber(value) {
        if (!value || value === "-")
            return null;
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    }
    function parseCompactRetrievalLedgerRow(raw) {
        const parts = String(raw || "").split("|");
        if (parts[0] !== COMPACT_RETRIEVAL_LEDGER_VERSION || parts.length < 24)
            return null;
        const source = parts[5] === "R" ? "R" : parts[5] === "S" ? "S" : null;
        if (!source)
            return null;
        const decode = (value) => {
            if (!value || value === "-")
                return "";
            try {
                return decodeURIComponent(value);
            }
            catch (_) {
                return value;
            }
        };
        return {
            raw, at: Number(parts[1]) || 0, nodeId: decode(parts[4]), source,
            rank: parseCompactLedgerNumber(parts[6]), selected: parts[7] === "1",
            queryCount: Math.max(0, Number(parts[8]) || 0), calendarDay: decode(parts[9]),
            calendarAgeDays: parseCompactLedgerNumber(parts[10]), content: parseCompactLedgerNumber(parts[11]),
            dialogueSemantic: parseCompactLedgerNumber(parts[12]), dialogueSemanticContribution: parseCompactLedgerNumber(parts[13]),
            dialogueLexical: parseCompactLedgerNumber(parts[14]), dialogueLexicalContribution: parseCompactLedgerNumber(parts[15]),
            activation: parseCompactLedgerNumber(parts[16]), activationContribution: parseCompactLedgerNumber(parts[17]),
            likeBonus: parseCompactLedgerNumber(parts[18]), total: parseCompactLedgerNumber(parts[19]),
            dialogueSemanticWeight: parseCompactLedgerNumber(parts[20]), dialogueLexicalWeight: parseCompactLedgerNumber(parts[21]),
            activationWeight: parseCompactLedgerNumber(parts[22]), likeBaseWeight: parseCompactLedgerNumber(parts[23]),
        };
    }
    async function ensureCompactRetrievalLedgerLoaded() {
        if (compactRetrievalLedgerLoaded)
            return;
        try {
            const saved = await risuai.pluginStorage.getItem(COMPACT_RETRIEVAL_LEDGER_KEY);
            compactRetrievalLedger = Array.isArray(saved)
                ? saved.filter((row) => typeof row === "string" && row.startsWith(`${COMPACT_RETRIEVAL_LEDGER_VERSION}|`))
                : [];
        }
        catch (error) {
            compactRetrievalLedger = [];
            console.log("[Hypirk] Failed to load compact retrieval ledger:", error);
        }
        compactRetrievalLedgerLoaded = true;
    }
    async function appendCompactRetrievalLedgerRows(rows) {
        if (rows.length === 0)
            return;
        await ensureCompactRetrievalLedgerLoaded();
        compactRetrievalLedger.push(...rows);
        const seenPerNode = new Map();
        const keptReverse = [];
        for (let i = compactRetrievalLedger.length - 1; i >= 0; i--) {
            const parsed = parseCompactRetrievalLedgerRow(compactRetrievalLedger[i]);
            if (!parsed)
                continue;
            const seen = seenPerNode.get(parsed.nodeId) ?? 0;
            if (seen >= COMPACT_RETRIEVAL_HISTORY_PER_NODE)
                continue;
            seenPerNode.set(parsed.nodeId, seen + 1);
            keptReverse.push(compactRetrievalLedger[i]);
            if (keptReverse.length >= COMPACT_RETRIEVAL_LEDGER_MAX_ROWS)
                break;
        }
        compactRetrievalLedger = keptReverse.reverse();
        try {
            await risuai.pluginStorage.setItem(COMPACT_RETRIEVAL_LEDGER_KEY, compactRetrievalLedger);
        }
        catch (error) {
            console.log("[Hypirk] Failed to save compact retrieval ledger:", error);
        }
    }
    function compactRetrievalHistoryForNode(nodeId) {
        return compactRetrievalLedger.map(parseCompactRetrievalLedgerRow)
            .filter((row) => Boolean(row && row.nodeId === nodeId))
            .slice(-COMPACT_RETRIEVAL_HISTORY_PER_NODE).reverse();
    }
    let chunkSize = DEFAULT_CHUNK_SIZE;
    let retainedMessagesAfterSummary = DEFAULT_RETAINED_MESSAGES_AFTER_SUMMARY;
    let maxMemoryTokens = DEFAULT_MAX_MEMORY_TOKENS;
    let summaryPrompt = DEFAULT_SUMMARY_PROMPT;
    let activeSummaryPresetName = "";
    let isSummarizing = false;
    let includeUserMessages = true;
    let embeddingContextMessages = 5;
    let queryParagraphGroupSize = 2;
    let embeddingUrl = "";
    let embeddingModel = "";
    let embeddingApiKey = "";
    // Global retrieval tuning values. Kept outside summary presets so changing
    // a summarization preset cannot silently change Similar ranking behavior.
    let dialogueLocalWeight = DEFAULT_DIALOGUE_LOCAL_WEIGHT;
    let dialogueEmbeddingWeight = DEFAULT_DIALOGUE_EMBEDDING_WEIGHT;
    let activationCueWeight = DEFAULT_ACTIVATION_CUE_WEIGHT;
    let likeBonusBase = DEFAULT_LIKE_BONUS_BASE;
    let recentMemoryRatio = DEFAULT_RECENT_MEMORY_RATIO;
    let memoryInjectionAnchor = DEFAULT_MEMORY_INJECTION_ANCHOR;
    let memoryInjectionTemplate = DEFAULT_MEMORY_INJECTION_TEMPLATE;
    let memoryInjectionNamespace = "";
    let memoryInjectionProfilesCache = [];
    let activeMemoryInjectionProfileId = "";
    let memoryInjectionDraft = null;
    let memorySeparator = DEFAULT_MEMORY_SEPARATOR;
    let lorebookSeparator = DEFAULT_LOREBOOK_SEPARATOR;
    let maxLorebookTokens = DEFAULT_MAX_LOREBOOK_TOKENS;
    let eventFormat = DEFAULT_EVENT_FORMAT;
    let uiColorPreset = "graphite";
    const READING_SCALE_PRESETS = [0.9, 1, 1.1, 1.2];
    const READING_FONT_OPTIONS = [
        { value: "sans", label: "고딕" },
        { value: "ridi_batang", label: "리디 바탕" },
        { value: "bookk_myungjo", label: "부크크명조" },
    ];
    let readingScale = 0.9;
    let readingFontFamily = "sans";
    let nodeTranslationApiUrl = "";
    let nodeTranslationApiKey = "";
    let nodeTranslationModel = "";
    let nodeTranslationLanguage = "한국어";
    let nodeTranslationPrompt = DEFAULT_NODE_TRANSLATION_PROMPT;
    let nodeTranslationMaxTokens = 4096;
    let nodeTranslationTemperature = 0.2;
    let debugMode = false;
    // Provider usage from one completed main request is consumed before the next.
    let autoSummaryDbPermission = null;
    let autoSummaryFetchLogsPermission = null;
    let autoSummaryRequestProbes = [];
    const autoSummaryConsumedFetchKeys = new Set();
    let autoSummaryReconcileGeneration = 0;
    let currentCharacterTimelineSettings = {
        timelineDateRegex: "",
        timelineDateRegexFlags: "i",
        dateCaptureGroup: 1,
    };
    let currentUiTimelineDetection = null;
    // ── Regex Library / Engine ─────────────────────────────────────────────
    let regexLibraryCache = [];
    const expandedRegexRuleIds = new Set();
    function makeRegexRuleId() {
        return `rx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    }
    function normalizeJsRegexFlags(raw) {
        const text = typeof raw === "string" ? raw.split("<", 1)[0] : "";
        const allowed = new Set("dgimsuvy".split(""));
        const unique = [];
        for (const ch of text)
            if (allowed.has(ch) && !unique.includes(ch))
                unique.push(ch);
        return unique.join("") || "g";
    }
    function createRegexRule(partial = {}) {
        return {
            id: partial.id || makeRegexRuleId(),
            name: partial.name || "새 정규식",
            pattern: partial.pattern || "",
            replacement: partial.replacement || "",
            flags: normalizeJsRegexFlags(partial.flags),
            enabled: partial.enabled !== false,
            globalEnabled: partial.globalEnabled === true,
            targets: {
                summarySource: partial.targets?.summarySource === true,
                chatQuery: partial.targets?.chatQuery === true,
                memoryEmbedding: partial.targets?.memoryEmbedding === true,
            },
        };
    }
    function createDefaultRegexRules() {
        const shared = {
            replacement: "",
            flags: "g",
            enabled: true,
            globalEnabled: true,
            targets: { summarySource: true, chatQuery: true, memoryEmbedding: true },
        };
        return [
            createRegexRule({
                ...shared,
                id: "hypirk_default_trim_ooc",
                name: "OOC 트리밍",
                pattern: "\\(OOC:[\\s\\S]*\\)",
            }),
            createRegexRule({
                ...shared,
                id: "hypirk_default_trim_says_nothing",
                name: "says nothing 트리밍",
                pattern: "\\*says nothing\\*",
            }),
        ];
    }
    function normalizeStoredRegexRule(value) {
        if (!value || typeof value !== "object")
            return null;
        const raw = value;
        return createRegexRule({
            id: typeof raw.id === "string" && raw.id ? raw.id : makeRegexRuleId(),
            name: typeof raw.name === "string" ? raw.name : "정규식",
            pattern: typeof raw.pattern === "string" ? raw.pattern : "",
            replacement: typeof raw.replacement === "string" ? raw.replacement : "",
            flags: typeof raw.flags === "string" ? raw.flags : "g",
            enabled: raw.enabled !== false,
            globalEnabled: raw.globalEnabled === true,
            targets: {
                summarySource: raw.targets?.summarySource === true,
                chatQuery: raw.targets?.chatQuery === true,
                memoryEmbedding: raw.targets?.memoryEmbedding === true,
            },
        });
    }
    async function loadRegexLibrary() {
        try {
            const saved = await risuai.pluginStorage.getItem(REGEX_LIBRARY_STORAGE_KEY);
            regexLibraryCache = Array.isArray(saved)
                ? saved.map(normalizeStoredRegexRule).filter((rule) => Boolean(rule))
                : [];
            const defaultsVersion = Number(await risuai.pluginStorage.getItem(REGEX_DEFAULTS_VERSION_KEY)) || 0;
            if (defaultsVersion < REGEX_DEFAULTS_VERSION) {
                const defaultRules = createDefaultRegexRules();
                const missingRules = defaultRules.filter((defaultRule) => !regexLibraryCache.some((rule) => rule.id === defaultRule.id || rule.pattern === defaultRule.pattern));
                regexLibraryCache.unshift(...missingRules);
                await risuai.pluginStorage.setItem(REGEX_LIBRARY_STORAGE_KEY, regexLibraryCache);
                await risuai.pluginStorage.setItem(REGEX_DEFAULTS_VERSION_KEY, REGEX_DEFAULTS_VERSION);
            }
        }
        catch (_) {
            regexLibraryCache = [];
        }
    }
    async function saveRegexLibrary() {
        invalidateUiSessionRenderData();
        await risuai.pluginStorage.setItem(REGEX_LIBRARY_STORAGE_KEY, regexLibraryCache);
    }
    function getEffectiveRegexRules(target) {
        const chatIds = new Set(state.regexRuleIds ?? []);
        return regexLibraryCache.filter((rule) => rule.enabled && rule.targets[target] && (rule.globalEnabled || chatIds.has(rule.id)));
    }
    function replaceRegexRule(content, rule) {
        const regex = new RegExp(rule.pattern, normalizeJsRegexFlags(rule.flags));
        if (rule.replacement !== "")
            return content.replace(regex, rule.replacement);
        // Empty replacement + whole-line match: remove the line break with the line.
        // This prevents a stripped one-line block from turning into an artificial
        // blank paragraph that would later become its own Query-separation boundary.
        const globalRegex = regex.global
            ? regex
            : new RegExp(regex.source, `${regex.flags}g`);
        const matches = [...content.matchAll(globalRegex)];
        if (matches.length === 0)
            return content;
        let result = content;
        for (let i = matches.length - 1; i >= 0; i--) {
            const match = matches[i];
            const start = match.index ?? 0;
            const end = start + match[0].length;
            const lineStart = result.lastIndexOf("\n", start - 1) + 1;
            const nextBreak = result.indexOf("\n", end);
            const lineEnd = nextBreak >= 0 ? nextBreak : result.length;
            const before = result.slice(lineStart, start);
            const after = result.slice(end, lineEnd);
            const wholeLine = /^[ \t]*$/.test(before) && /^[ \t]*$/.test(after);
            if (wholeLine) {
                if (nextBreak >= 0) {
                    result = result.slice(0, lineStart) + result.slice(nextBreak + 1);
                }
                else if (lineStart > 0) {
                    result = result.slice(0, lineStart - 1);
                }
                else {
                    result = "";
                }
            }
            else {
                result = result.slice(0, start) + result.slice(end);
            }
            if (!regex.global)
                break;
        }
        return result;
    }
    function applyRegexRulesToText(content, rules) {
        let result = trimBuiltInThoughtsTags(content);
        for (const rule of rules) {
            if (!rule.pattern)
                continue;
            try {
                result = replaceRegexRule(result, rule);
            }
            catch (_) { /* invalid rule stays editable and is skipped */ }
        }
        return result;
    }
    /** Built-in pipeline cleanup; intentionally not exposed as a toggleable library rule. */
    function trimBuiltInThoughtsTags(content) {
        return content.replace(/<Thoughts>([\s\S]*?)<\/Thoughts>/g, "");
    }
    function parseRisuRegexFile(json) {
        try {
            const data = JSON.parse(json);
            if (data?.type !== "regex" || !Array.isArray(data?.data))
                return null;
            return data.data
                .filter((entry) => entry && entry.type === "editprocess" && typeof entry.in === "string")
                .map((entry) => createRegexRule({
                name: typeof entry.comment === "string" && entry.comment.trim() ? entry.comment.trim() : "Risu 정규식",
                pattern: entry.in || "",
                replacement: typeof entry.out === "string" ? entry.out : "",
                flags: entry.ableFlag === true ? normalizeJsRegexFlags(entry.flag) : "g",
            }));
        }
        catch (_) {
            return null;
        }
    }
    async function fetchCurrentCharacterRegexRules() {
        try {
            const char = await risuai.getCharacterFromIndex(currentCharIndex);
            const raw = Array.isArray(char?.customscript)
                ? char.customscript
                : Array.isArray(char?.customScript) ? char.customScript : [];
            return raw
                .filter((entry) => entry && entry.type === "editprocess" && typeof entry.in === "string")
                .map((entry) => createRegexRule({
                name: typeof entry.comment === "string" && entry.comment.trim() ? entry.comment.trim() : "Risu 정규식",
                pattern: entry.in || "",
                replacement: typeof entry.out === "string" ? entry.out : "",
                flags: entry.ableFlag === true ? normalizeJsRegexFlags(entry.flag) : "g",
            }));
        }
        catch (_) {
            return [];
        }
    }
    function getRegexTargetSignature(target) {
        return JSON.stringify(getEffectiveRegexRules(target).map((r) => [r.id, r.pattern, r.replacement, normalizeJsRegexFlags(r.flags)]));
    }
    /**
     * Read all messages from the current chat (raw, no regex applied).
     * Returns only chat.message — indices match RisuAI chat_index (0, 1, 2, …).
     * The first message (chat_index -1) is NOT included; use fetchFirstMessage() for it.
     */
    const FIRST_MESSAGE_CHAT_ID = "__hypirkproto_first_message__";
    /** Current chatId -> current chat array-index map, refreshed whenever messages are read. */
    let messageIndexByChatId = new Map();
    let currentRawMessages = [];
    let lastRawSourceMessageCount = 0;
    let lastRawMessagesMissingChatId = 0;
    let currentLinkHealthStatus = "no-links";
    let linkRecoveryIdentityConfirmed = true;
    let linkFallbackBoundaryAllowed = false;
    const SETFULLCHAT_DEBUG_LOG_LIMIT = 200;
    const setFullChatDebugLog = [];
    const setFullChatModuleMatchCache = new Map();
    let lastSetFullChatLuaScan = null;
    function pushSetFullChatDebug(event, details = {}) {
        const entry = {
            at: Date.now(),
            event,
            charId: currentCharId,
            chatId: currentChatId,
            details,
        };
        setFullChatDebugLog.push(entry);
        if (setFullChatDebugLog.length > SETFULLCHAT_DEBUG_LOG_LIMIT) {
            setFullChatDebugLog.splice(0, setFullChatDebugLog.length - SETFULLCHAT_DEBUG_LOG_LIMIT);
        }
        console.log(`[Hypirk][setFullChat] ${event}`, details);
    }
    function findSetFullChatCallsInTriggers(triggers, source, sourceName, sourceId) {
        if (!Array.isArray(triggers))
            return [];
        const matches = [];
        for (const trigger of triggers) {
            if (!trigger || typeof trigger !== "object")
                continue;
            const effects = Array.isArray(trigger.effect) ? trigger.effect : [];
            for (const effect of effects) {
                if (!effect || effect.type !== "triggerlua" || typeof effect.code !== "string")
                    continue;
                const lineNumbers = [];
                const regex = /\bsetFullChat\s*\(/g;
                let match;
                while ((match = regex.exec(effect.code)) !== null) {
                    lineNumbers.push(effect.code.slice(0, match.index).split("\n").length);
                }
                if (lineNumbers.length === 0)
                    continue;
                matches.push({
                    source,
                    sourceName,
                    sourceId,
                    triggerName: typeof trigger.comment === "string" ? trigger.comment : "",
                    triggerType: typeof trigger.type === "string" ? trigger.type : undefined,
                    lineNumbers,
                    matchCount: lineNumbers.length,
                });
            }
        }
        return matches;
    }
    async function scanCurrentSetFullChatLua(includeModules = false) {
        const result = {
            scannedAt: Date.now(),
            detected: false,
            detectionMode: "direct-call-token",
            characterScanned: false,
            moduleScan: includeModules ? "unavailable" : "not-requested",
            matches: [],
        };
        try {
            const char = await risuai.getCharacterFromIndex(currentCharIndex);
            result.characterScanned = Boolean(char);
            result.matches.push(...findSetFullChatCallsInTriggers(char?.triggerscript, "character", String(char?.name ?? "current character"), String(char?.chaId ?? currentCharId)));
        }
        catch (_) {
            result.characterScanned = false;
        }
        const contextKey = `${currentCharId}\u0000${currentChatId}`;
        if (!includeModules) {
            const cachedModuleMatches = setFullChatModuleMatchCache.get(contextKey);
            if (cachedModuleMatches?.length) {
                result.matches.push(...cachedModuleMatches.map(match => ({ ...match })));
                result.moduleScan = "available";
            }
        }
        if (includeModules) {
            try {
                let granted = true;
                if (typeof risuai.requestPluginPermission === "function") {
                    granted = await risuai.requestPluginPermission("db");
                }
                if (!granted) {
                    result.moduleScan = "permission-denied";
                }
                else if (typeof risuai.getDatabase === "function") {
                    const [chat, db] = await Promise.all([
                        risuai.getChatFromIndex(currentCharIndex, currentChatIndex).catch(() => null),
                        risuai.getDatabase(["modules", "enabledModules"]).catch(() => null),
                    ]);
                    const activeIds = new Set([
                        ...(Array.isArray(chat?.modules) ? chat.modules : []),
                        ...(Array.isArray(db?.enabledModules) ? db.enabledModules : []),
                    ].filter((id) => typeof id === "string"));
                    const modules = Array.isArray(db?.modules) ? db.modules : [];
                    const moduleMatches = [];
                    for (const module of modules) {
                        if (!module || typeof module !== "object" || !activeIds.has(String(module.id ?? "")))
                            continue;
                        moduleMatches.push(...findSetFullChatCallsInTriggers(module.trigger, "module", String(module.name ?? module.id ?? "module"), String(module.id ?? "")));
                    }
                    setFullChatModuleMatchCache.set(contextKey, moduleMatches.map(match => ({ ...match })));
                    result.matches.push(...moduleMatches);
                    result.moduleScan = "available";
                }
            }
            catch (_) {
                result.moduleScan = "unavailable";
            }
        }
        result.detected = result.matches.length > 0;
        lastSetFullChatLuaScan = result;
        return result;
    }
    function isMessageAnchor(value) {
        if (!value || typeof value !== "object")
            return false;
        const anchor = value;
        return (Number.isSafeInteger(anchor.sourceIndex) && Number(anchor.sourceIndex) >= -1 &&
            typeof anchor.role === "string" &&
            Number.isSafeInteger(anchor.contentLength) && Number(anchor.contentLength) >= 0 &&
            typeof anchor.contentHash === "string" &&
            anchor.contentHash.length > 0);
    }
    async function hashMessageContent(content) {
        const encoded = new TextEncoder().encode(content);
        const digest = await crypto.subtle.digest("SHA-256", encoded);
        return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    async function createMessageAnchor(message) {
        return {
            sourceIndex: message.index,
            role: message.role,
            contentLength: message.content.length,
            contentHash: await hashMessageContent(message.content),
        };
    }
    async function createMessageAnchors(messages) {
        const anchors = [];
        for (const message of messages) {
            if (message.chatId === FIRST_MESSAGE_CHAT_ID) {
                anchors.push(null);
                continue;
            }
            try {
                anchors.push(await createMessageAnchor(message));
            }
            catch (error) {
                anchors.push(null);
            }
        }
        return anchors;
    }
    function anchorMatchesMessage(anchor, message, contentHash) {
        return (anchor.role === message.role &&
            anchor.contentLength === message.content.length &&
            anchor.contentHash === contentHash);
    }
    function messageFingerprintKey(role, contentLength, contentHash) {
        return `${role}\u0000${contentLength}\u0000${contentHash}`;
    }
    // RisuAI invokes the process hook once per message while building a request.
    // Keep the existing 300 ms rolling burst, then preserve its result for a
    // further 3 seconds. A hook arriving during that grace window promotes the
    // burst to extended reuse, capped at 10 seconds from the full refresh.
    const PROCESS_CHAT_MAP_BURST_IDLE_MS = 300;
    const PROCESS_CHAT_MAP_PROMOTION_GRACE_MS = 3_000;
    const PROCESS_CHAT_MAP_ABSOLUTE_MAX_MS = 10_000;
    let processChatMapReusePhase = "idle";
    let processChatMapLastHookCompletedAt = Number.NEGATIVE_INFINITY;
    let processChatMapReuseStartedAt = Number.NEGATIVE_INFINITY;
    let processChatMapReuseGeneration = 0;
    let processChatMapAbsoluteResetTimer = null;
    let processChatMapRefreshInFlight = null;
    function resetProcessChatMapReuse(reason) {
        const hadReusableResult = processChatMapReusePhase !== "idle";
        processChatMapReuseGeneration += 1;
        processChatMapReusePhase = "idle";
        processChatMapLastHookCompletedAt = Number.NEGATIVE_INFINITY;
        processChatMapReuseStartedAt = Number.NEGATIVE_INFINITY;
        if (processChatMapAbsoluteResetTimer !== null) {
            window.clearTimeout(processChatMapAbsoluteResetTimer);
            processChatMapAbsoluteResetTimer = null;
        }
    }
    function beginProcessChatMapReuse(generation) {
        if (generation !== processChatMapReuseGeneration)
            return;
        const now = performance.now();
        processChatMapReusePhase = "short";
        processChatMapReuseStartedAt = now;
        processChatMapLastHookCompletedAt = now;
        if (processChatMapAbsoluteResetTimer !== null) {
            window.clearTimeout(processChatMapAbsoluteResetTimer);
        }
        processChatMapAbsoluteResetTimer = window.setTimeout(() => {
            if (generation === processChatMapReuseGeneration &&
                processChatMapReusePhase !== "idle") {
                resetProcessChatMapReuse("absolute-timeout");
            }
        }, PROCESS_CHAT_MAP_ABSOLUTE_MAX_MS);
    }
    async function readChatMessagesRaw() {
        if (currentCharIndex < 0 || currentChatIndex < 0) {
            currentRawMessages = [];
            lastRawSourceMessageCount = 0;
            lastRawMessagesMissingChatId = 0;
            messageIndexByChatId = new Map();
            return [];
        }
        try {
            const chat = await risuai.getChatFromIndex(currentCharIndex, currentChatIndex);
            if (!chat || !Array.isArray(chat.message)) {
                currentRawMessages = [];
                lastRawSourceMessageCount = 0;
                lastRawMessagesMissingChatId = 0;
                messageIndexByChatId = new Map();
                return [];
            }
            const messages = [];
            const indexByChatId = new Map();
            let messagesMissingChatId = 0;
            for (let index = 0; index < chat.message.length; index++) {
                const msg = chat.message[index];
                const role = msg.role.toString().toLowerCase();
                let content = msg.data.toString();
                const chatId = typeof msg.chatId === "string" ? msg.chatId : String(msg.chatId ?? "");
                if (content && !chatId)
                    messagesMissingChatId += 1;
                if (content && chatId) {
                    messages.push({ chatId, index, role, content });
                    indexByChatId.set(chatId, index);
                }
            }
            messageIndexByChatId = indexByChatId;
            currentRawMessages = messages;
            lastRawSourceMessageCount = chat.message.length;
            lastRawMessagesMissingChatId = messagesMissingChatId;
            return messages;
        }
        catch (e) {
            currentRawMessages = [];
            lastRawSourceMessageCount = 0;
            lastRawMessagesMissingChatId = 0;
            messageIndexByChatId = new Map();
            return [];
        }
    }
    function getRealMessageRefPointers() {
        const used = new Set(state.entries.flatMap(entry => entry.linkedMessages));
        return [...used].map(slot => state.messages[String(slot)])
            .filter((record) => !!record && record.chatId !== FIRST_MESSAGE_CHAT_ID);
    }
    async function registerMessages(messages) {
        const slots = [];
        for (const message of messages) {
            const existing = Object.entries(state.messages).find(([, record]) => record.chatId === message.chatId);
            let slot = existing ? Number(existing[0]) : message.index;
            if (!existing && state.messages[String(slot)]) {
                slot = Math.max(0, ...Object.keys(state.messages).map(Number)) + 1;
            }
            state.messages[String(slot)] = {
                chatId: message.chatId, index: message.index,
                anchor: state.hashRecoveryEnabled === true && message.index !== -1
                    ? await createMessageAnchor(message)
                    : null,
            };
            slots.push(slot);
        }
        return [...new Set(slots)];
    }
    async function backfillMessageAnchors(messages) {
        if (!linkRecoveryIdentityConfirmed || state.hashRecoveryEnabled !== true)
            return 0;
        const byId = new Map(messages.map(message => [message.chatId, message]));
        let added = 0;
        for (const record of getRealMessageRefPointers()) {
            const message = byId.get(record.chatId);
            if (message && !record.anchor) {
                record.anchor = await createMessageAnchor(message);
                added++;
            }
        }
        return added;
    }
    function updateLastVerifiedSummarizedIndex() {
        const resolved = getResolvedLastSummarizedMsgIndex();
        if (resolved < 0 || state.lastVerifiedSummarizedIndex === resolved)
            return false;
        state.lastVerifiedSummarizedIndex = resolved;
        return true;
    }
    async function tryBootstrapSetFullChatRewrite(messages, pointers, directResolved, directRatio) {
        if (state.hashRecoveryEnabled === true || pointers.length === 0)
            return false;
        // The observed RisuAI setFullChat bug rewrites every message chatId while
        // preserving the chat room, array order and indices. Stay deliberately
        // strict here: this bootstrap path is only for that all-IDs-rewritten shape.
        if (directResolved.length !== 0) {
            pushSetFullChatDebug("bootstrap-skip-partial-direct-match", {
                pointerCount: pointers.length,
                directResolvedCount: directResolved.length,
                directRatio,
            });
            return false;
        }
        const luaScan = await scanCurrentSetFullChatLua(false);
        pushSetFullChatDebug("lua-scan-auto", {
            detected: luaScan.detected,
            detectionMode: luaScan.detectionMode,
            characterScanned: luaScan.characterScanned,
            moduleScan: luaScan.moduleScan,
            matches: luaScan.matches.map(match => ({
                source: match.source,
                sourceName: match.sourceName,
                sourceId: match.sourceId,
                triggerName: match.triggerName,
                triggerType: match.triggerType,
                lineNumbers: match.lineNumbers,
                matchCount: match.matchCount,
            })),
        });
        if (!luaScan.detected) {
            pushSetFullChatDebug("bootstrap-rejected-no-setfullchat-lua", {
                pointerCount: pointers.length,
                directRatio,
            });
            return false;
        }
        const messagesByIndex = new Map(messages.map(message => [message.index, message]));
        const assignments = [];
        const targetChatIds = new Set();
        try {
            for (const pointer of pointers) {
                const candidate = messagesByIndex.get(pointer.index);
                if (!candidate || !candidate.chatId || targetChatIds.has(candidate.chatId)) {
                    pushSetFullChatDebug("bootstrap-rejected-index-shape", {
                        pointerCount: pointers.length,
                        directRatio,
                        failedIndex: pointer.index,
                        candidateFound: Boolean(candidate),
                        candidateHasChatId: Boolean(candidate?.chatId),
                        duplicateTargetChatId: Boolean(candidate?.chatId && targetChatIds.has(candidate.chatId)),
                    });
                    return false;
                }
                targetChatIds.add(candidate.chatId);
                assignments.push({
                    pointer,
                    message: candidate,
                    anchor: await createMessageAnchor(candidate),
                });
            }
        }
        catch (error) {
            pushSetFullChatDebug("bootstrap-rejected-hash-error", {
                pointerCount: pointers.length,
                error: String(error),
            });
            return false;
        }
        const mapping = assignments.map(({ pointer, message }) => ({
            index: pointer.index,
            oldChatId: pointer.chatId,
            newChatId: message.chatId,
        }));
        for (const { pointer, message, anchor } of assignments) {
            pointer.chatId = message.chatId;
            pointer.index = message.index;
            pointer.anchor = anchor;
        }
        state.hashRecoveryEnabled = true;
        state.hashRecoveryActivatedAt = Date.now();
        currentLinkHealthStatus = "recovered";
        linkFallbackBoundaryAllowed = true;
        updateLastVerifiedSummarizedIndex();
        pushSetFullChatDebug("bootstrap-recovery-success", {
            pointerCount: pointers.length,
            directRatioBefore: directRatio,
            hashRecoveryEnabled: true,
            hashRecoveryActivatedAt: state.hashRecoveryActivatedAt,
            mapping,
        });
        await saveStateForChat(currentCharId, currentChatId);
        return true;
    }
    async function reconcileMessageLinks(messages) {
        const pointers = getRealMessageRefPointers();
        if (pointers.length === 0) {
            currentLinkHealthStatus = "no-links";
            linkFallbackBoundaryAllowed = false;
            return;
        }
        if (!linkRecoveryIdentityConfirmed) {
            currentLinkHealthStatus = "identity-mismatch";
            linkFallbackBoundaryAllowed = false;
            return;
        }
        const directResolved = pointers.filter((pointer) => messageIndexByChatId.has(pointer.chatId));
        let indicesChanged = false;
        for (const record of directResolved) {
            const index = messageIndexByChatId.get(record.chatId);
            if (record.index !== index)
                indicesChanged = true;
            record.index = index;
        }
        const directRatio = directResolved.length / pointers.length;
        if (messages.length === 0 && lastRawSourceMessageCount > 0) {
            currentLinkHealthStatus = "unsafe";
            linkFallbackBoundaryAllowed =
                lastRawMessagesMissingChatId > 0 &&
                    typeof state.lastVerifiedSummarizedIndex === "number";
            return;
        }
        if (messages.length === 0) {
            currentLinkHealthStatus = "partial";
            linkFallbackBoundaryAllowed = false;
            if (state.lastVerifiedSummarizedIndex !== -1) {
                state.lastVerifiedSummarizedIndex = -1;
                await saveStateForChat(currentCharId, currentChatId);
            }
            return;
        }
        if (directResolved.length === pointers.length) {
            currentLinkHealthStatus = "healthy";
            linkFallbackBoundaryAllowed = true;
            if (updateLastVerifiedSummarizedIndex() || indicesChanged) {
                await saveStateForChat(currentCharId, currentChatId);
            }
            return;
        }
        // A small number of missing IDs normally means that source messages were
        // actually deleted. Remaining stable IDs are already sufficient and no
        // content hashing is needed.
        if (directRatio >= 0.6) {
            currentLinkHealthStatus = "partial";
            linkFallbackBoundaryAllowed = true;
            if (updateLastVerifiedSummarizedIndex() || indicesChanged) {
                await saveStateForChat(currentCharId, currentChatId);
            }
            return;
        }
        pushSetFullChatDebug("link-rewrite-candidate", {
            pointerCount: pointers.length,
            directResolvedCount: directResolved.length,
            directRatio,
            hashRecoveryEnabled: state.hashRecoveryEnabled === true,
            ownerIdentityConfirmed: linkRecoveryIdentityConfirmed,
        });
        if (state.hashRecoveryEnabled !== true) {
            const bootstrapped = await tryBootstrapSetFullChatRewrite(messages, pointers, directResolved, directRatio);
            if (bootstrapped)
                return;
        }
        const anchoredPointers = pointers.filter((pointer) => pointer.anchor !== null);
        if (anchoredPointers.length === 0) {
            currentLinkHealthStatus = "unanchored";
            linkFallbackBoundaryAllowed = false;
            return;
        }
        const hashesByIndex = new Map();
        try {
            for (const message of messages) {
                hashesByIndex.set(message.index, await hashMessageContent(message.content));
            }
        }
        catch (error) {
            currentLinkHealthStatus = "unsafe";
            linkFallbackBoundaryAllowed = false;
            return;
        }
        const messagesByIndex = new Map(messages.map((message) => [message.index, message]));
        const usedCurrentIndices = new Set();
        const resolvedCurrentIndex = new Map();
        for (const pointer of directResolved) {
            const currentIndex = messageIndexByChatId.get(pointer.chatId);
            if (currentIndex === undefined)
                continue;
            usedCurrentIndices.add(currentIndex);
            resolvedCurrentIndex.set(pointer, currentIndex);
        }
        const recovered = new Map();
        let sameIndexRecovered = 0;
        for (const pointer of anchoredPointers) {
            if (resolvedCurrentIndex.has(pointer))
                continue;
            const candidate = messagesByIndex.get(pointer.anchor.sourceIndex);
            const candidateHash = candidate ? hashesByIndex.get(candidate.index) : undefined;
            if (candidate &&
                candidateHash &&
                !usedCurrentIndices.has(candidate.index) &&
                anchorMatchesMessage(pointer.anchor, candidate, candidateHash)) {
                recovered.set(pointer, candidate);
                usedCurrentIndices.add(candidate.index);
                sameIndexRecovered += 1;
            }
        }
        // If a source message was deleted, later indices shift. Match only
        // fingerprints that are unique on both sides; ambiguous duplicate text is
        // deliberately left orphaned.
        const currentByFingerprint = new Map();
        for (const message of messages) {
            const hash = hashesByIndex.get(message.index);
            if (!hash)
                continue;
            const key = messageFingerprintKey(message.role, message.content.length, hash);
            const group = currentByFingerprint.get(key);
            if (group)
                group.push(message);
            else
                currentByFingerprint.set(key, [message]);
        }
        const storedFingerprintCounts = new Map();
        for (const pointer of anchoredPointers) {
            const key = messageFingerprintKey(pointer.anchor.role, pointer.anchor.contentLength, pointer.anchor.contentHash);
            storedFingerprintCounts.set(key, (storedFingerprintCounts.get(key) ?? 0) + 1);
        }
        for (const pointer of anchoredPointers) {
            if (resolvedCurrentIndex.has(pointer) || recovered.has(pointer))
                continue;
            const key = messageFingerprintKey(pointer.anchor.role, pointer.anchor.contentLength, pointer.anchor.contentHash);
            const candidates = currentByFingerprint.get(key) ?? [];
            if (storedFingerprintCounts.get(key) !== 1 || candidates.length !== 1)
                continue;
            const candidate = candidates[0];
            if (usedCurrentIndices.has(candidate.index))
                continue;
            recovered.set(pointer, candidate);
            usedCurrentIndices.add(candidate.index);
        }
        const orderedMatches = anchoredPointers
            .map((pointer) => {
            const currentIndex = resolvedCurrentIndex.get(pointer) ?? recovered.get(pointer)?.index;
            return currentIndex === undefined
                ? null
                : { sourceIndex: pointer.anchor.sourceIndex, currentIndex };
        })
            .filter((match) => match !== null)
            .sort((a, b) => a.sourceIndex - b.sourceIndex);
        const monotonic = orderedMatches.every((match, index) => index === 0 || orderedMatches[index - 1].currentIndex < match.currentIndex);
        const confirmedCount = directResolved.length + recovered.size;
        const confirmedCurrentIndices = [
            ...resolvedCurrentIndex.values(),
            ...[...recovered.values()].map((message) => message.index),
        ];
        const confirmedCurrentCount = new Set(confirmedCurrentIndices).size;
        const lastConfirmedCurrentIndex = confirmedCurrentIndices.length > 0 ? Math.max(...confirmedCurrentIndices) : -1;
        // When deletion is evidenced below, missing stored anchors may represent
        // intentionally deleted source messages. In that case, evaluate only the
        // current messages through the last link we could confirm; newer messages
        // after that boundary are still unsummarized and must not dilute the ratio.
        // Without deletion evidence, retain the stricter stored-link denominator.
        const comparableCurrentCount = messages.filter((message) => message.index <= lastConfirmedCurrentIndex).length;
        const deletionDetected = messages.length < pointers.length ||
            (typeof state.lastVerifiedSummarizedIndex === "number" &&
                state.lastVerifiedSummarizedIndex >= messages.length) ||
            orderedMatches.some((match) => match.currentIndex < match.sourceIndex);
        const recoveryDenominator = deletionDetected
            ? comparableCurrentCount
            : pointers.length;
        const recoveryNumerator = deletionDetected
            ? confirmedCurrentCount
            : confirmedCount;
        const confirmedRatio = recoveryDenominator > 0 ? recoveryNumerator / recoveryDenominator : 0;
        const requiredConfirmedCount = Math.min(3, recoveryDenominator);
        const accepted = deletionDetected
            ? monotonic &&
                recoveryDenominator > 0 &&
                recoveryNumerator >= requiredConfirmedCount &&
                confirmedRatio >= 0.8
            : monotonic &&
                (pointers.length <= 2
                    ? confirmedCount === pointers.length && sameIndexRecovered === recovered.size
                    : confirmedCount >= 3 && confirmedRatio >= 0.8);
        if (!accepted) {
            if (state.hashRecoveryEnabled === true) {
                pushSetFullChatDebug("anchored-recovery-rejected", {
                    pointerCount: pointers.length,
                    directResolvedCount: directResolved.length,
                    directRatio,
                    recoveredCount: recovered.size,
                    confirmedCount,
                    confirmedRatio,
                    monotonic,
                    deletionDetected,
                });
            }
            currentLinkHealthStatus = "unsafe";
            linkFallbackBoundaryAllowed = monotonic && confirmedCount > 0;
            return;
        }
        for (const [pointer, message] of recovered) {
            pointer.chatId = message.chatId;
            pointer.index = message.index;
            if (pointer.anchor)
                pointer.anchor.sourceIndex = message.index;
        }
        currentLinkHealthStatus = confirmedCount === pointers.length ? "recovered" : "partial";
        if (state.hashRecoveryEnabled === true) {
            pushSetFullChatDebug("anchored-recovery-success", {
                pointerCount: pointers.length,
                directResolvedCount: directResolved.length,
                directRatioBefore: directRatio,
                recoveredCount: recovered.size,
                confirmedCount,
                status: currentLinkHealthStatus,
            });
        }
        linkFallbackBoundaryAllowed = true;
        updateLastVerifiedSummarizedIndex();
        await saveStateForChat(currentCharId, currentChatId);
    }
    async function refreshChatContextForRequestBurst() {
        const now = performance.now();
        if (processChatMapRefreshInFlight) {
            const generation = processChatMapReuseGeneration;
            await processChatMapRefreshInFlight;
            if (generation === processChatMapReuseGeneration &&
                processChatMapReusePhase !== "idle") {
                processChatMapLastHookCompletedAt = performance.now();
            }
            return false;
        }
        if (processChatMapReusePhase !== "idle") {
            const absoluteAgeMs = now - processChatMapReuseStartedAt;
            if (absoluteAgeMs >= PROCESS_CHAT_MAP_ABSOLUTE_MAX_MS) {
                resetProcessChatMapReuse("absolute-timeout");
            }
            else if (processChatMapReusePhase === "extended") {
                processChatMapLastHookCompletedAt = now;
                return false;
            }
            else {
                const idleMs = now - processChatMapLastHookCompletedAt;
                if (idleMs <= PROCESS_CHAT_MAP_BURST_IDLE_MS) {
                    processChatMapLastHookCompletedAt = now;
                    return false;
                }
                if (idleMs <=
                    PROCESS_CHAT_MAP_BURST_IDLE_MS + PROCESS_CHAT_MAP_PROMOTION_GRACE_MS) {
                    processChatMapReusePhase = "extended";
                    processChatMapLastHookCompletedAt = now;
                    return false;
                }
            }
        }
        if (processChatMapAbsoluteResetTimer !== null) {
            window.clearTimeout(processChatMapAbsoluteResetTimer);
            processChatMapAbsoluteResetTimer = null;
        }
        processChatMapReusePhase = "idle";
        processChatMapReuseGeneration += 1;
        const refreshGeneration = processChatMapReuseGeneration;
        const refreshPromise = (async () => {
            await ensureChatContext();
            // detectCurrentChat() already snapshots the full character once for this
            // request burst. Reuse the supaMemory value captured in that snapshot
            // instead of cloning the whole character again for every process hook.
            if (isRisuMemoryToggleEnabled()) {
                suspendAutoSummaryRequestTrackingForNativeMemory();
            }
            const messages = await readChatMessagesRaw();
            await reconcileMessageLinks(messages);
        })();
        processChatMapRefreshInFlight = refreshPromise;
        let refreshSucceeded = false;
        try {
            await refreshPromise;
            refreshSucceeded = true;
        }
        finally {
            if (processChatMapRefreshInFlight === refreshPromise) {
                processChatMapRefreshInFlight = null;
            }
            if (refreshSucceeded)
                beginProcessChatMapReuse(refreshGeneration);
        }
        return true;
    }
    /**
     * Fetch the first message (chat_index -1) from the character object.
     * Returns null if not available.
     */
    async function fetchFirstMessage() {
        if (currentCharIndex < 0 || currentChatIndex < 0) {
            return null;
        }
        const detectedMetadata = getDetectedChatUiMetadataForCurrentContext();
        if (detectedMetadata?.firstMessageResolved) {
            const result = detectedMetadata.firstMessage;
            return result;
        }
        try {
            const chat = await risuai.getChatFromIndex(currentCharIndex, currentChatIndex);
            const char = await risuai.getCharacterFromIndex(currentCharIndex);
            if (!char)
                return null;
            const resolved = resolveFirstMessageFromCharacterAndChat(char, chat);
            const result = resolved.message;
            return result;
        }
        catch (error) {
            console.log("[Hypirk] fetchFirstMessage — error:", error);
            return null;
        }
    }
    /**
     * Return a processed copy of the requested message subset.
     * Only call this on the subset you actually need.
     */
    // Derived text never aliases the raw snapshot used for identity/date detection.
    function applyRegexToMessages(messages, target = "summarySource") {
        const rules = getEffectiveRegexRules(target);
        return messages.map(message => ({
            ...message,
            content: applyRegexRulesToText(message.content, rules),
        }));
    }
    // ── Batch Embedding ─────────────────────────────────────────────────────
    function normalizeEmbeddingWhitespace(text) {
        return text
            .replace(/\r\n?/g, "\n")
            .split("\n")
            .map((line) => line.trim())
            .join("\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }
    function buildNodeEmbeddingText(node) {
        const rules = getEffectiveRegexRules("memoryEmbedding");
        // Strip only the memory retrieval surface; stored content and chat queries stay intact.
        // A speaker-only dialogue line contributes no narration (including its speaker label).
        let narration = node.content.replace(/\r\n?/g, "\n").split("\n")
            .map(line => parseStructuredContentDialogueLine(line) ? "" : line).join("\n");
        for (const pattern of dialogueQuotePatterns())
            narration = narration.replace(pattern, " ");
        return normalizeEmbeddingWhitespace(applyRegexRulesToText(narration, rules));
    }
    /**
     * Dialogue is a derived retrieval surface extracted from quoted speech in Content.
     * All dialogue found in one Memory is intentionally bundled into one semantic vector.
     */
    function buildNodeDialogueEmbeddingBundle(node) {
        const rules = getEffectiveRegexRules("memoryEmbedding");
        const seen = new Set();
        const out = [];
        const add = (text) => {
            const normalized = normalizeEmbeddingWhitespace(applyRegexRulesToText(text, rules));
            if (!normalized || seen.has(normalized))
                return;
            seen.add(normalized);
            out.push(normalized);
        };
        for (const dialogue of extractDialogueLocalLines(node.content))
            add(dialogue);
        return out.join("\n");
    }
    function buildCurrentDialogueEmbeddingBundle(currentDialogues) {
        const seen = new Set();
        const out = [];
        for (const dialogue of currentDialogues) {
            const normalized = normalizeEmbeddingWhitespace(dialogue);
            if (!normalized || seen.has(normalized))
                continue;
            seen.add(normalized);
            out.push(normalized);
        }
        return out.join("\n");
    }
    async function getDialogueEmbeddingConfigHash() {
        return hashMessageContent([
            "dialogue-embedding-schema:v2-bundle",
            embeddingUrl,
            embeddingModel,
            `memory-embedding-regex:${getRegexTargetSignature("memoryEmbedding")}`,
        ].join("\u0000"));
    }
    async function getNodeEmbeddingConfigHash() {
        return hashMessageContent([
            `node-embedding-schema:${NODE_EMBEDDING_SCHEMA_VERSION}`,
            "node-embedding-text-mode:narration-only-query-separated-v2",
            embeddingUrl,
            embeddingModel,
            `memory-embedding-regex:${getRegexTargetSignature("memoryEmbedding")}`,
        ].join("\u0000"));
    }
    function isFiniteEmbeddingVector(value, dimensions) {
        return (Array.isArray(value) &&
            value.length > 0 &&
            (dimensions === undefined || value.length === dimensions) &&
            value.every((item) => typeof item === "number" && Number.isFinite(item)));
    }
    /**
     * Fetch embeddings for multiple texts in a single API call.
     * Returns an array of embeddings in the same order as the input texts.
     * Each element is either a number[] or null if the embedding failed.
     */
    async function getBatchEmbeddings(texts) {
        if (!embeddingUrl || texts.length === 0) {
            return texts.map(() => null);
        }
        try {
            const body = {
                input: texts,
            };
            if (embeddingModel)
                body.model = embeddingModel;
            const headers = { "Content-Type": "application/json" };
            if (embeddingApiKey)
                headers["Authorization"] = `Bearer ${embeddingApiKey}`;
            const response = await risuai.nativeFetch(embeddingUrl, {
                method: "POST",
                headers,
                body: JSON.stringify(body),
            });
            if (!response.ok) {
                console.log("[Hypirk] Batch embedding fetch failed, status:", response.status);
                return texts.map(() => null);
            }
            const data = await response.json();
            // OpenAI format: { data: [{ embedding: [...] }, ...] }
            if (data.data && Array.isArray(data.data)) {
                const result = data.data.map((item) => {
                    const emb = item?.embedding;
                    return Array.isArray(emb) && emb.length > 0 ? emb : null;
                });
                const successful = result.filter((item) => item !== null);
                return result;
            }
            return texts.map(() => null);
        }
        catch (e) {
            console.log("[Hypirk] Batch embedding fetch error:", e);
            return texts.map(() => null);
        }
    }
    // Shared mechanics; each lane retains its own text surface and scoring policy.
    async function ensureCandidateEmbeddings(candidates, { configHash, dimensions, readCache, writeCache }) {
        const statuses = new Map();
        const missing = [];
        for (const candidate of candidates) {
            const text = candidate.text ?? candidate.memoryText;
            if (!text) { statuses.set(candidate, "empty-node"); continue; }
            const cache = readCache(candidate);
            if (cache?.sourceHash === candidate.sourceHash && cache?.configHash === configHash &&
                isFiniteEmbeddingVector(cache.embedding, dimensions)) {
                candidate.embedding = cache.embedding;
                statuses.set(candidate, "ok");
            }
            else missing.push(candidate);
        }
        const batches = [];
        let batch = [], tokens = 0;
        for (const candidate of missing) {
            const cost = await countTokens(candidate.text ?? candidate.memoryText);
            if (batch.length && tokens + cost > EMBEDDING_BATCH_TOKEN_LIMIT) {
                batches.push(batch); batch = []; tokens = 0;
            }
            batch.push(candidate); tokens += cost;
        }
        if (batch.length) batches.push(batch);
        for (const batch of batches) {
            const vectors = await getBatchEmbeddings(batch.map(candidate => candidate.text ?? candidate.memoryText));
            batch.forEach((candidate, index) => {
                const embedding = vectors[index];
                if (!isFiniteEmbeddingVector(embedding, dimensions)) {
                    statuses.set(candidate, "node-failed"); return;
                }
                candidate.embedding = embedding;
                writeCache(candidate, { embedding, sourceHash: candidate.sourceHash, configHash });
                statuses.set(candidate, "ok");
            });
        }
        return statuses;
    }
    function cosineSimilarity(a, b) {
        if (a.length !== b.length || a.length === 0)
            return 0;
        let dot = 0, normA = 0, normB = 0;
        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        const denom = Math.sqrt(normA) * Math.sqrt(normB);
        return denom === 0 ? 0 : dot / denom;
    }
    // Existing heuristic cache is deliberately retained for EMBEDDING batch caps.
    // The configured embedding model is not guaranteed to use o200k_base.
    const tokenCache = new Map();
    const TOKEN_CACHE_MAX = 500;
    // Main-model memory budgeting gets a separate exact-o200k cache.
    const memoryTokenCache = new Map();
    const MEMORY_TOKEN_CACHE_MAX = 1000;
    let o200kEncoder = null;
    let o200kEncoderLoad = null;
    let memoryTokenizerStatus = "idle";
    let memoryTokenizerSource = "";
    let memoryTokenizerError = "";
    function heuristicEstimateTokens(text) {
        let tokens = 0;
        for (const ch of text) {
            const code = ch.charCodeAt(0);
            if (code >= 0xac00 && code <= 0xd7af)
                tokens += 0.5; // Korean
            else if (code >= 0x4e00 && code <= 0x9fff)
                tokens += 0.5; // CJK
            else if (code >= 0x3040 && code <= 0x30ff)
                tokens += 0.5; // Japanese
            else
                tokens += 0.25;
        }
        return Math.ceil(tokens);
    }
    /**
     * Heuristic token count used only for embedding request batching. Do not use
     * this for the Recent/Similar memory budget: that path has its own o200k count.
     */
    async function countTokens(text) {
        if (!text)
            return 0;
        const cached = tokenCache.get(text);
        if (cached !== undefined)
            return cached;
        const count = heuristicEstimateTokens(text);
        if (tokenCache.size >= TOKEN_CACHE_MAX) {
            const firstKey = tokenCache.keys().next().value;
            if (firstKey !== undefined)
                tokenCache.delete(firstKey);
        }
        tokenCache.set(text, count);
        return count;
    }
    function isO200kRankPayload(value) {
        return Boolean(value &&
            typeof value.pat_str === "string" && value.pat_str.length > 20 &&
            typeof value.bpe_ranks === "string" && value.bpe_ranks.length > 1_000_000 &&
            value.special_tokens && typeof value.special_tokens === "object" &&
            Number(value.special_tokens["<|endoftext|>"]) === 199999);
    }
    async function remoteTokenizerImport(url) {
        // Variable URL keeps TypeScript/Risu from treating this as a local package.
        return await import(url);
    }
    async function saveO200kPayloadToLocalStorage(payload, source) {
        try {
            const storage = await getDeviceLocalEmbeddingStorage();
            if (!storage?.setItem)
                return;
            const record = {
                format: "hypirk-o200k-tokenizer-cache",
                schemaVersion: 1,
                encoding: "o200k_base",
                source,
                payload,
                updatedAt: Date.now(),
            };
            await storage.setItem(LOCAL_O200K_TOKENIZER_KEY, record);
        }
        catch (error) {
            // Cache failure must not disable an otherwise working tokenizer session.
            console.warn("[Hypirk] Could not cache o200k_base rank payload:", error);
        }
    }
    async function loadO200kRankPayload() {
        const storage = await getDeviceLocalEmbeddingStorage();
        // 1) Verified steady-state path: LocalPluginStorage rank payload.
        if (storage?.getItem) {
            try {
                const cached = await storage.getItem(LOCAL_O200K_TOKENIZER_KEY);
                if (cached?.format === "hypirk-o200k-tokenizer-cache" &&
                    cached.schemaVersion === 1 &&
                    cached.encoding === "o200k_base" &&
                    isO200kRankPayload(cached.payload)) {
                    return { payload: cached.payload, source: "LocalPluginStorage cache" };
                }
                if (cached && storage?.removeItem)
                    await storage.removeItem(LOCAL_O200K_TOKENIZER_KEY);
            }
            catch (error) {
                console.warn("[Hypirk] Could not read cached o200k_base ranks:", error);
            }
        }
        // 2) First-run bootstrap. This exact CDN JSON route succeeded in the Probe.
        try {
            if (typeof risuai.nativeFetch !== "function")
                throw new Error("nativeFetch unavailable");
            const response = await risuai.nativeFetch(O200K_TOKENIZER_DATA_URL, { method: "GET" });
            if (!response?.ok)
                throw new Error(`HTTP ${response?.status ?? "?"}`);
            if (typeof response.text !== "function")
                throw new Error("Response.text() unavailable");
            const payload = JSON.parse(await response.text());
            if (!isO200kRankPayload(payload))
                throw new Error("unexpected o200k rank payload");
            await saveO200kPayloadToLocalStorage(payload, "tiktoken.pages.dev");
            return { payload, source: "tiktoken.pages.dev → LocalPluginStorage" };
        }
        catch (nativeError) {
            console.warn("[Hypirk] o200k_base CDN bootstrap failed; trying ESM ranks:", nativeError);
        }
        // 3) Secondary bootstrap route. Probe also verified this rank-module shape.
        const ranksModule = await remoteTokenizerImport(JS_TIKTOKEN_RANKS_URL);
        const payload = ranksModule?.default ?? ranksModule;
        if (!isO200kRankPayload(payload))
            throw new Error("esm.sh o200k rank module has an unexpected shape");
        await saveO200kPayloadToLocalStorage(payload, "esm.sh ranks/o200k_base");
        return { payload, source: "esm.sh ranks → LocalPluginStorage" };
    }
    function encodeO200kText(encoder, text) {
        // Memory text is ordinary user/model text, not a request control stream.
        // If the JS implementation exposes encodeOrdinary, prefer it so strings that
        // merely look like special tokens are counted as ordinary text.
        if (typeof encoder?.encodeOrdinary === "function")
            return encoder.encodeOrdinary(text);
        return encoder.encode(text);
    }
    async function ensureO200kMemoryTokenizer() {
        if (o200kEncoder)
            return o200kEncoder;
        if (o200kEncoderLoad)
            return o200kEncoderLoad;
        memoryTokenizerStatus = "loading";
        memoryTokenizerError = "";
        o200kEncoderLoad = (async () => {
            try {
                const { payload, source } = await loadO200kRankPayload();
                const lite = await remoteTokenizerImport(JS_TIKTOKEN_LITE_URL);
                const Tiktoken = lite?.Tiktoken ?? lite?.default?.Tiktoken;
                if (typeof Tiktoken !== "function")
                    throw new Error("js-tiktoken/lite Tiktoken export not found");
                const encoder = new Tiktoken(payload);
                const smoke = encodeO200kText(encoder, "Hypirk tokenizer check");
                if (!smoke || !Number.isFinite(Number(smoke.length)))
                    throw new Error("o200k_base smoke encode failed");
                o200kEncoder = encoder;
                memoryTokenizerStatus = "ready";
                memoryTokenizerSource = source;
                memoryTokenCache.clear();
                console.log(`[Hypirk] o200k_base memory tokenizer ready (${source}).`);
                return encoder;
            }
            catch (error) {
                o200kEncoder = null;
                memoryTokenizerStatus = "fallback";
                memoryTokenizerSource = "";
                memoryTokenizerError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
                console.warn("[Hypirk] o200k_base memory tokenizer unavailable; memory budgets use the legacy heuristic for this session.", error);
                return null;
            }
        })();
        return o200kEncoderLoad;
    }
    function cacheMemoryTokenCount(text, count) {
        if (memoryTokenCache.size >= MEMORY_TOKEN_CACHE_MAX) {
            const firstKey = memoryTokenCache.keys().next().value;
            if (firstKey !== undefined)
                memoryTokenCache.delete(firstKey);
        }
        memoryTokenCache.set(text, count);
        return count;
    }
    function countMemoryTokensSync(text) {
        if (!text)
            return 0;
        const cached = memoryTokenCache.get(text);
        if (cached !== undefined)
            return cached;
        if (!o200kEncoder)
            return heuristicEstimateTokens(text);
        try {
            const tokenIds = encodeO200kText(o200kEncoder, text);
            const count = Number(tokenIds?.length ?? NaN);
            if (!Number.isFinite(count))
                throw new Error("encode() result has no finite length");
            return cacheMemoryTokenCount(text, count);
        }
        catch (error) {
            console.warn("[Hypirk] o200k_base synchronous memory count failed; using heuristic for this text:", error);
            return heuristicEstimateTokens(text);
        }
    }
    async function countMemoryTokens(text) {
        if (!text)
            return 0;
        const cached = memoryTokenCache.get(text);
        if (cached !== undefined)
            return cached;
        const encoder = o200kEncoder ?? await ensureO200kMemoryTokenizer();
        if (!encoder)
            return heuristicEstimateTokens(text);
        try {
            const tokenIds = encodeO200kText(encoder, text);
            const count = Number(tokenIds?.length ?? NaN);
            if (!Number.isFinite(count))
                throw new Error("encode() result has no finite length");
            return cacheMemoryTokenCount(text, count);
        }
        catch (error) {
            console.warn("[Hypirk] o200k_base memory count failed; using heuristic for this text:", error);
            return heuristicEstimateTokens(text);
        }
    }
    function memoryTokenizerStatusLabel() {
        if (memoryTokenizerStatus === "ready")
            return "o200k_base ✓";
        if (memoryTokenizerStatus === "loading")
            return "o200k_base 준비 중…";
        if (memoryTokenizerStatus === "fallback")
            return "휴리스틱 fallback";
        return "o200k_base 대기";
    }
    function memoryTokenizerStatusTitle() {
        if (memoryTokenizerStatus === "ready") {
            return `기억 예산/표시는 o200k_base로 계산합니다.${memoryTokenizerSource ? ` (${memoryTokenizerSource})` : ""}`;
        }
        if (memoryTokenizerStatus === "fallback") {
            return `o200k_base 초기화 실패로 현재 세션은 기존 휴리스틱을 사용합니다.${memoryTokenizerError ? ` ${memoryTokenizerError}` : ""}`;
        }
        return "기억 예산용 o200k_base 토크나이저를 준비합니다.";
    }
    /** UI-only count for the content-only memory body. */
    function estimateNodeTokens(node) {
        return countMemoryTokensSync(node.content);
    }
    function clearTokenCache() {
        tokenCache.clear();
        memoryTokenCache.clear();
    }
    let memoryReadCache = null;
    /** Synchronous, read-only render/sort scope; never retain across an await/edit. */
    function withMemoryReadCache(read) {
        if (memoryReadCache)
            return read();
        const entries = new Map();
        const positions = new Map();
        const displayNumbers = new Map();
        const nodes = [];
        state.entries.forEach((entry, index) => {
            positions.set(entry, index);
            if (entry.memory) {
                nodes.push(entry.memory);
                entries.set(entry.memory, entry);
                displayNumbers.set(entry.memory, nodes.length);
            }
        });
        memoryReadCache = { nodes, entries, positions, displayNumbers,
            indices: new Map(), linkKeys: new Map(), times: new Map() };
        try {
            return read();
        }
        finally {
            memoryReadCache = null;
        }
    }
    function memoryDisplayNumber(memory) {
        return withMemoryReadCache(() => memoryReadCache.displayNumbers.get(memory) ?? "?");
    }
    function sortNodesByTime(nodes, direction = "asc") {
        return withMemoryReadCache(() => [...nodes].sort((a, b) => direction === "desc" ? compareNodesByTime(b, a) : compareNodesByTime(a, b)));
    }
    function memorySortTime(memory) {
        if (!memoryReadCache)
            return parseTimeString(memory.time);
        if (!memoryReadCache.times.has(memory))
            memoryReadCache.times.set(memory, parseTimeString(memory.time));
        return memoryReadCache.times.get(memory);
    }
    /** Retrieval and memory editing operate only on populated entries. */
    function getNodes() {
        return memoryReadCache?.nodes ?? state.entries.flatMap(entry => entry.memory ? [entry.memory] : []);
    }
    function getMemoryEntry(memory) {
        return memoryReadCache ? memoryReadCache.entries.get(memory) : state.entries.find(entry => entry.memory === memory);
    }
    function appendMemoryEntry(memory, linkedMessages = []) {
        const entry = { memory, linkedMessages: [...new Set(linkedMessages)] };
        state.entries.push(entry);
        return entry;
    }
    /** UI lookup only: no persisted entry/group ID. */
    function entryPosition(entry) {
        return String(memoryReadCache?.positions.get(entry) ?? state.entries.indexOf(entry));
    }
    function memoryLinkKey(memory) {
        if (!memory)
            return "";
        const cached = memoryReadCache?.linkKeys.get(memory);
        if (cached !== undefined)
            return cached;
        const entry = getMemoryEntry(memory);
        const key = entry?.linkedMessages.length ? [...entry.linkedMessages].sort((a, b) => a - b).join(",") : "";
        memoryReadCache?.linkKeys.set(memory, key);
        return key;
    }
    /** Internal identity never follows UI numbering and is never reused after deletion. */
    let memoryIdSequence = 0;
    function nextNodeId() {
        return typeof crypto.randomUUID === "function"
            ? `m_${crypto.randomUUID()}`
            : `m_${Date.now().toString(36)}_${(++memoryIdSequence).toString(36)}_${Math.random().toString(36).slice(2)}`;
    }
    /** Find a memory by id. */
    function findNodeById(nodeId) {
        return getNodes().find((memory) => memory.id === nodeId);
    }
    /** Delete only the containing entry; shared message records and sibling entries remain independent. */
    function removeNodeById(nodeId) {
        const index = state.entries.findIndex(entry => entry.memory?.id === nodeId);
        if (index === -1)
            return false;
        state.entries.splice(index, 1);
        markEmbeddingCacheDirty();
        markDerivedCacheDirty();
        state.lastChosenNodeIds = state.lastChosenNodeIds.filter((id) => id !== nodeId);
        state.lastRecentNodeIds = state.lastRecentNodeIds.filter((id) => id !== nodeId);
        delete state.lastNodeScores[nodeId];
        state.translationVisibleNodeIds = (state.translationVisibleNodeIds ?? []).filter((id) => id !== nodeId);
        return true;
    }
    /** Stable ordering for memory IDs. */
    function compareNodeIds(a, b) {
        return a.id.localeCompare(b.id, undefined, { numeric: true });
    }
    function nodeSourceHash(node) {
        const source = node.content;
        let hash = 2166136261;
        for (let i = 0; i < source.length; i++) {
            hash ^= source.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(16).padStart(8, "0");
    }
    function removeEmbeddingCacheFields(node) {
        delete node.embedding;
        delete node.embeddingSourceHash;
        delete node.embeddingConfigHash;
        delete node.dialogueEmbeddingChildren;
        delete node.dialogueEmbeddingSourceHash;
        delete node.dialogueEmbeddingConfigHash;
    }
    function clearNodeEmbedding(node) {
        const hadCache = hasAnyEmbeddingCache(node);
        removeEmbeddingCacheFields(node);
        if (hadCache)
            markEmbeddingCacheDirty();
    }
    function hasAnyEmbeddingCache(node) {
        return (node.embedding !== undefined ||
            node.embeddingSourceHash !== undefined ||
            node.embeddingConfigHash !== undefined ||
            node.dialogueEmbeddingChildren !== undefined ||
            node.dialogueEmbeddingSourceHash !== undefined ||
            node.dialogueEmbeddingConfigHash !== undefined ||
            node.embeddingChildren !== undefined ||
            node.embeddingConfig !== undefined);
    }
    function parseNodeTranslationResponse(raw) {
        const fenced = raw.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? raw.trim();
        const firstBrace = fenced.indexOf("{");
        const lastBrace = fenced.lastIndexOf("}");
        const jsonText = firstBrace >= 0 && lastBrace > firstBrace
            ? fenced.slice(firstBrace, lastBrace + 1)
            : fenced;
        const parsed = JSON.parse(jsonText);
        if (!parsed || typeof parsed.content !== "string") {
            throw new Error("번역 응답에 content가 없습니다.");
        }
        return { content: parsed.content };
    }
    async function requestNodeTranslation(node) {
        const source = { ...node };
        const targetLanguage = nodeTranslationLanguage;
        const model = nodeTranslationModel;
        if (!nodeTranslationApiUrl || !nodeTranslationModel) {
            throw new Error("설정 > 기능에서 노드 번역 API URL과 모델명을 먼저 입력해주세요.");
        }
        const headers = { "Content-Type": "application/json" };
        if (nodeTranslationApiKey)
            headers.Authorization = `Bearer ${nodeTranslationApiKey}`;
        const response = await risuai.nativeFetch(nodeTranslationApiUrl, {
            method: "POST",
            headers,
            body: JSON.stringify({
                model,
                messages: [
                    { role: "system", content: nodeTranslationPrompt },
                    {
                        role: "user",
                        content: JSON.stringify({
                            targetLanguage,
                            content: source.content,
                        }),
                    },
                ],
                temperature: nodeTranslationTemperature,
                max_tokens: nodeTranslationMaxTokens,
            }),
        });
        if (!response.ok) {
            const detail = await response.text().catch(() => "");
            throw new Error(`번역 API 오류 (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`);
        }
        const data = await response.json();
        const raw = data?.choices?.[0]?.message?.content;
        if (typeof raw !== "string" || !raw.trim()) {
            throw new Error("번역 API 응답에서 choices[0].message.content를 찾지 못했습니다.");
        }
        const translated = parseNodeTranslationResponse(raw);
        return {
            ...translated,
            targetLanguage,
            sourceHash: nodeSourceHash(source),
            updatedAt: Date.now(),
            model,
            manuallyEdited: false,
        };
    }
    function nowTimeString() {
        const d = new Date();
        const pad = (n) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    function normalizeTimeString(ts) {
        const value = ts.trim();
        const normalizePart = (part) => {
            const trimmed = part.trim();
            let match = trimmed.match(/^(\d{1,4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{1,2})$/);
            if (match) {
                return `${match[1].padStart(4, "0")}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")} ${match[4].padStart(2, "0")}:${match[5].padStart(2, "0")}`;
            }
            match = trimmed.match(/^(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{1,2})$/);
            if (match) {
                return `${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")} ${match[3].padStart(2, "0")}:${match[4].padStart(2, "0")}`;
            }
            match = trimmed.match(/^(\d{1,2}):(\d{1,2})$/);
            if (match)
                return `${match[1].padStart(2, "0")}:${match[2].padStart(2, "0")}`;
            return null;
        };
        const rangeMatch = value.match(/^(.+?)(\s*(?:→|->)\s*)(.+)$/);
        if (rangeMatch) {
            const start = normalizePart(rangeMatch[1]);
            const end = normalizePart(rangeMatch[3]);
            if (start && end)
                return `${start}${rangeMatch[2]}${end}`;
        }
        return normalizePart(value) ?? value;
    }
    function parseStructuredContentDialogueLine(line) {
        const colon = line.indexOf(":");
        if (colon <= 0)
            return null;
        const speaker = line.slice(0, colon).trim();
        const rest = line.slice(colon + 1).trim();
        if (!speaker || !rest)
            return null;
        const texts = [];
        const quotePattern = /"([^"\r\n]+)"|“([^”\r\n]+)”|「([^」\r\n]+)」|『([^』\r\n]+)』/g;
        let residual = "";
        let cursor = 0;
        let match;
        while ((match = quotePattern.exec(rest)) !== null) {
            residual += rest.slice(cursor, match.index);
            const text = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").trim();
            if (text)
                texts.push(text);
            cursor = match.index + match[0].length;
        }
        residual += rest.slice(cursor);
        if (texts.length === 0 || residual.trim())
            return null;
        return { speaker, texts };
    }
    function extractStructuredContentDialogues(text) {
        const out = [];
        for (const line of String(text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
            const parsed = parseStructuredContentDialogueLine(line);
            if (!parsed)
                continue;
            for (const dialogueText of parsed.texts)
                out.push({ speaker: parsed.speaker, text: dialogueText });
        }
        return out;
    }
    function renderContentRichText(content) {
        return String(content ?? "").replace(/\r\n?/g, "\n").split("\n").map((line) => {
            const parsed = parseStructuredContentDialogueLine(line);
            if (!parsed)
                return escapeHtml(line);
            const quotes = parsed.texts.map((text) => `"${escapeHtml(text)}"`).join(" ");
            return `<span class="dl-line"><span class="dl-speaker">${escapeHtml(parsed.speaker)}:</span> ${quotes}</span>`;
        }).join("\n");
    }
    function ensureMemoryWrappedSummary(raw) {
        const trimmed = String(raw ?? "").trim();
        if (!trimmed)
            return "";
        // Respect explicit memory blocks from a user-authored summarization prompt.
        // An untagged model response is treated as one Memory.
        if (/<memory>[\s\S]*?<\/memory>/i.test(trimmed))
            return trimmed;
        return `<memory>\n${trimmed}\n</memory>`;
    }
    function parseMemoriesFromSummary(raw) {
        const memories = [];
        const getId = nextNodeId;
        if (/<\/?scene\b/i.test(raw)) {
            // Accept either memory > scene or scene > memory boundaries.
            const indexedText = String(raw).replace(/<\/?memory\s*>/gi, "").trim()
                .replace(/^```(?:xml|html|text)?\s*\n/i, "").replace(/\n```\s*$/, "");
            const indexRegex = /<scene\s+range\s*=\s*(["'])\s*(-?\d+)\s*(?:[-–—]\s*(-?\d+)\s*)?\1\s*>([\s\S]*?)<\/scene\s*>/gi;
            let cursor = 0;
            let indexed;
            while ((indexed = indexRegex.exec(indexedText)) !== null) {
                if (indexedText.slice(cursor, indexed.index).trim() || /<\/?scene\b/i.test(indexed[4]))
                    throw new Error("Invalid or mixed summary scene blocks");
                const start = Number(indexed[2]);
                const end = Number(indexed[3] ?? indexed[2]);
                if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < -1 || end < start)
                    throw new Error("Invalid summary scene range");
                const memory = parseMemoryBlock(indexed[4], getId);
                if (!memory)
                    throw new Error("Empty summary scene block");
                memories.push({ memory, indexRange: [start, end] });
                cursor = indexRegex.lastIndex;
            }
            if (!memories.length || indexedText.slice(cursor).trim())
                throw new Error("Malformed summary scene blocks");
            return memories;
        }
        const memoryRegex = /<memory>([\s\S]*?)<\/memory>/gi;
        let match;
        while ((match = memoryRegex.exec(raw)) !== null) {
            const memory = parseMemoryBlock(match[1], getId);
            if (memory)
                memories.push({ memory, indexRange: null });
        }
        return memories;
    }
    function resolveSummaryEntries(parsed, linkedMessages) {
        const slots = [...new Set(linkedMessages)];
        const indexed = parsed.some(item => item.indexRange !== null);
        const records = slots.map(slot => ({ slot, index: state.messages[String(slot)]?.index }));
        const indices = records.map(record => record.index).filter(Number.isInteger);
        if (indexed && indices.length !== records.length)
            throw new Error("Summary source message references are unresolved");
        const minIndex = Math.min(...indices);
        const maxIndex = Math.max(...indices);
        const covered = new Set();
        const entries = parsed.map(({ memory, indexRange }) => {
            let links = slots;
            if (indexRange) {
                const [start, end] = indexRange;
                if (start < minIndex || end > maxIndex)
                    throw new Error("Summary index range is outside the source window");
                links = records.filter(record => record.index >= start && record.index <= end).map(record => record.slot);
                if (!links.length)
                    throw new Error("Summary index range has no source messages");
            }
            links.forEach(slot => covered.add(slot));
            return { memory, linkedMessages: [...links] };
        });
        // Keep processed source coverage, including omitted user messages, without
        // attaching those messages to an unrelated indexed memory.
        const uncovered = slots.filter(slot => !covered.has(slot));
        if ((indexed || !parsed.length) && uncovered.length)
            entries.push({ memory: null, linkedMessages: uncovered });
        entries.indexed = indexed;
        return entries;
    }
    function parseSummaryEntries(raw, linkedMessages) {
        try {
            return resolveSummaryEntries(parseMemoriesFromSummary(raw), linkedMessages);
        }
        catch (error) {
            // Preserve paid model output even when scene syntax or source ranges
            // are unusable. Keep all response text and use the legacy full window.
            console.log("[Hypirk] Falling back to unsegmented summary:", error);
            const memory = parseMemoryBlock(String(raw).replace(/<\/?memory\s*>/gi, ""), nextNodeId);
            return [{ memory, linkedMessages: [...new Set(linkedMessages)] }];
        }
    }
    function splitTimeFromOpaqueContent(block) {
        const normalized = String(block ?? "").replace(/\r\n?/g, "\n").trim();
        const timeMatch = normalized.match(/(?:^|\n)\s*(?:시간|Time)\s*:\s*([^\n]+)/i);
        if (!timeMatch)
            return { time: null, content: normalized };
        const content = `${normalized.slice(0, timeMatch.index)}${normalized.slice((timeMatch.index ?? 0) + timeMatch[0].length)}`
            .replace(/^\n+|\n+$/g, "")
            .trim();
        return { time: normalizeTimeString(timeMatch[1].trim()), content };
    }
    function parseMemoryBlock(block, getId) {
        const parsed = splitTimeFromOpaqueContent(block);
        if (!parsed.content)
            return null;
        return {
            id: (getId ?? nextNodeId)(),
            time: parsed.time ?? "0000-00-00 00:00",
            category: "",
            tags: [],
            content: parsed.content,
            createdAt: Date.now(),
        };
    }
    // ── Storage ──────────────────────────────────────────────────────────────
    async function detectCurrentChat() {
        const ci = await risuai.getCurrentCharacterIndex();
        const chi = await risuai.getCurrentChatIndex();
        let charId = "";
        let chatId = "";
        let char = null;
        let chat = null;
        try {
            char = await risuai.getCharacterFromIndex(ci);
            if (char && char.chaId)
                charId = char.chaId;
        }
        catch (_) {
            /* fallback to empty */
        }
        try {
            chat = await risuai.getChatFromIndex(ci, chi);
            if (chat && chat.id)
                chatId = chat.id;
        }
        catch (_) {
            /* fallback to empty */
        }
        const firstMessageResult = char && chat
            ? resolveFirstMessageFromCharacterAndChat(char, chat)
            : { message: null, alternateGreetingSelected: false };
        detectedChatUiMetadata = {
            charIndex: ci,
            chatIndex: chi,
            charId,
            chatId,
            charName: char?.name ? char.name.toString() : `Char#${ci}`,
            chatName: chat?.name ? chat.name.toString() : `Chat#${chi}`,
            charResolved: Boolean(char),
            chatResolved: Boolean(chat),
            firstMessage: firstMessageResult.message,
            firstMessageResolved: Boolean(char && chat),
            alternateGreetingSelected: firstMessageResult.alternateGreetingSelected,
            risuMemoryToggleEnabled: Boolean(char?.supaMemory),
        };
        const result = { charIndex: ci, chatIndex: chi, charId, chatId };
        return result;
    }
    function createDefaultCharacterTimelineSettings() {
        return {
            timelineDateRegex: "",
            timelineDateRegexFlags: "i",
            dateCaptureGroup: 1,
        };
    }
    function getCharacterTimelineSettingsKey(charId) {
        return `${CHARACTER_TIMELINE_SETTINGS_PREFIX}${charId}`;
    }
    async function loadCharacterTimelineSettings(charId) {
        currentCharacterTimelineSettings = createDefaultCharacterTimelineSettings();
        if (!charId)
            return;
        try {
            const saved = await risuai.pluginStorage.getItem(getCharacterTimelineSettingsKey(charId));
            if (!saved || typeof saved !== "object")
                return;
            if (typeof saved.timelineDateRegex === "string") {
                currentCharacterTimelineSettings.timelineDateRegex = saved.timelineDateRegex;
            }
            if (typeof saved.timelineDateRegexFlags === "string") {
                currentCharacterTimelineSettings.timelineDateRegexFlags = saved.timelineDateRegexFlags;
            }
            if (Number.isInteger(saved.dateCaptureGroup) && saved.dateCaptureGroup >= 0) {
                currentCharacterTimelineSettings.dateCaptureGroup = saved.dateCaptureGroup;
            }
        }
        catch (_) {
            /* use defaults */
        }
    }
    async function saveCurrentCharacterTimelineSettings() {
        if (!currentCharId)
            return;
        await risuai.pluginStorage.setItem(getCharacterTimelineSettingsKey(currentCharId), currentCharacterTimelineSettings);
    }
    // A context lease lets an in-flight job finish against its original chat.
    // Switching waits for leases; nested jobs may share the still-active context.
    const activeChatOperations = new Set();
    let chatContextSwitch = null;
    async function withChatOperation(action) {
        while (chatContextSwitch)
            await chatContextSwitch;
        const owner = { state, charId: currentCharId, chatId: currentChatId };
        let release;
        const settled = new Promise(resolve => { release = resolve; });
        activeChatOperations.add(settled);
        try { return await action(owner); }
        finally {
            activeChatOperations.delete(settled);
            release();
        }
    }
    function isCurrentOperation(owner) {
        return owner.state === state && owner.charId === currentCharId && owner.chatId === currentChatId;
    }
    async function ensureChatContext() {
        while (chatContextSwitch || activeChatOperations.size) {
            if (chatContextSwitch) await chatContextSwitch;
            else await Promise.all([...activeChatOperations]);
        }
        const task = switchChatContext();
        chatContextSwitch = task;
        try { return await task; }
        finally { if (chatContextSwitch === task) chatContextSwitch = null; }
    }
    async function switchChatContext() {
        // Always resolve stable identities. Array indices can be reused while a
        // character/chat object is replaced or imported into the same slot.
        const { charIndex, chatIndex, charId, chatId } = await detectCurrentChat();
        if (charIndex === currentCharIndex &&
            chatIndex === currentChatIndex &&
            charId === currentCharId &&
            chatId === currentChatId) {
            return false; // No change
        }
        // Drain edits in the old chat before changing the global state/context.
        await flushInlineCardChanges();
        // Save current state before switching
        const previousStateSaved = Boolean(currentCharId && currentChatId);
        if (previousStateSaved) {
            await saveStateForChat(currentCharId, currentChatId);
        }
        // Load state for new chat
        resetProcessChatMapReuse("chat-switch");
        currentCharIndex = charIndex;
        currentChatIndex = chatIndex;
        currentCharId = charId;
        currentChatId = chatId;
        await loadStateForChat(charId, chatId);
        await loadCharacterTimelineSettings(charId);
        return true;
    }
    async function buildSetFullChatDebugReport() {
        const luaScan = await scanCurrentSetFullChatLua(true);
        const messages = await readChatMessagesRaw();
        const pointers = getRealMessageRefPointers();
        const directResolved = pointers.filter(pointer => messageIndexByChatId.has(pointer.chatId));
        const usedSlots = new Set(state.entries.flatMap(entry => entry.linkedMessages));
        const storedLinks = [...usedSlots]
            .map(slot => ({ slot, record: state.messages[String(slot)] }))
            .filter((item) => Boolean(item.record))
            .map(({ slot, record }) => ({
            slot,
            index: record.index,
            chatId: record.chatId,
            hasAnchor: record.anchor !== null,
            anchorSourceIndex: record.anchor?.sourceIndex ?? null,
        }));
        pushSetFullChatDebug("lua-scan-manual", {
            detected: luaScan.detected,
            characterScanned: luaScan.characterScanned,
            moduleScan: luaScan.moduleScan,
            matchCount: luaScan.matches.length,
        });
        return {
            format: "hypirk-setfullchat-debug",
            schemaVersion: 1,
            createdAt: new Date().toISOString(),
            currentContext: {
                currentCharIndex,
                currentChatIndex,
                currentCharId,
                currentChatId,
                ownerCharId: state.ownerCharId ?? null,
                ownerChatId: state.ownerChatId ?? null,
                ownerCharName: state.ownerCharName ?? null,
                ownerChatName: state.ownerChatName ?? null,
            },
            recoveryState: {
                hashRecoveryEnabled: state.hashRecoveryEnabled === true,
                hashRecoveryActivatedAt: state.hashRecoveryActivatedAt ?? null,
                linkHealthStatus: currentLinkHealthStatus,
                linkRecoveryIdentityConfirmed,
                linkFallbackBoundaryAllowed,
                lastVerifiedSummarizedIndex: state.lastVerifiedSummarizedIndex ?? null,
            },
            linkSnapshot: {
                pointerCount: pointers.length,
                directResolvedCount: directResolved.length,
                directRatio: pointers.length > 0 ? directResolved.length / pointers.length : null,
                anchoredPointerCount: pointers.filter(pointer => pointer.anchor !== null).length,
                rawMessageCount: messages.length,
                rawSourceMessageCount: lastRawSourceMessageCount,
                rawMessagesMissingChatId: lastRawMessagesMissingChatId,
                storedLinks,
                currentMessageIds: messages.map(message => ({ index: message.index, chatId: message.chatId })),
            },
            luaScan,
            sessionLog: [...setFullChatDebugLog],
            notes: [
                "No message content or Lua source code is included.",
                "Automatic detection recognizes direct setFullChat(...) call tokens in current-character Lua; module matches are reused after a manual debug scan grants DB access.",
                "Bootstrap recovery requires zero stored chatId matches and intact stored indices.",
            ],
        };
    }
    async function copyTextToClipboard(text) {
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        }
        catch (_) {
            // Some RisuAI builds do not grant clipboard-write to plugin iframes.
        }
        try {
            const textarea = document.createElement("textarea");
            textarea.value = text;
            textarea.setAttribute("readonly", "");
            textarea.style.position = "fixed";
            textarea.style.left = "-9999px";
            textarea.style.top = "0";
            document.body.appendChild(textarea);
            textarea.focus();
            textarea.select();
            const copied = document.execCommand("copy");
            textarea.remove();
            return copied;
        }
        catch (_) {
            return false;
        }
    }
    function sortEntriesByMessageIndex(entries, direction) {
        return withMemoryReadCache(() => [...entries].sort((a, b) => {
            const ai = getEntryMessageIndices(a), bi = getEntryMessageIndices(b);
            if (!ai.length || !bi.length)
                return ai.length ? -1 : bi.length ? 1 : 0;
            return direction === "desc" ? Math.max(...bi) - Math.max(...ai) : Math.min(...ai) - Math.min(...bi);
        }));
    }
    function getEntryMessageIndices(entry) {
        const cached = memoryReadCache?.indices.get(entry);
        if (cached)
            return cached;
        const indices = entry.linkedMessages.flatMap(slot => {
            const record = state.messages[String(slot)];
            if (!record)
                return [];
            if (record.chatId === FIRST_MESSAGE_CHAT_ID)
                return [-1];
            const index = messageIndexByChatId.get(record.chatId);
            return index === undefined ? [] : [index];
        }).sort((a, b) => a - b);
        memoryReadCache?.indices.set(entry, indices);
        return indices;
    }
    function getEntryMessageRefCount(entry) {
        return entry.linkedMessages.length;
    }
    function getResolvedLastSummarizedMsgIndex() {
        return Math.max(-1, ...state.entries.flatMap(getEntryMessageIndices));
    }
    /**
     * Use the live resolved boundary normally. During an ambiguous same-chat
     * metadata rewrite, retain the last verified boundary instead of treating
     * the entire history as newly unsummarized. The fallback is never used for
     * a cross-chat identity mismatch or when no content anchor matched.
     */
    function getLastSummarizedMsgIndex() {
        const resolved = getResolvedLastSummarizedMsgIndex();
        if (currentLinkHealthStatus === "unsafe" &&
            linkFallbackBoundaryAllowed &&
            typeof state.lastVerifiedSummarizedIndex === "number" &&
            currentRawMessages.length > 0) {
            return Math.min(state.lastVerifiedSummarizedIndex, currentRawMessages.length - 1);
        }
        return resolved;
    }
    function isLinkProcessingBlocked() {
        return (currentLinkHealthStatus === "unsafe" ||
            currentLinkHealthStatus === "identity-mismatch" ||
            currentLinkHealthStatus === "unanchored");
    }
    /**
     * Read pending (unsummarized) messages from chat history on-the-fly.
     * Returns messages whose index is > lastSummarizedMsgIndex.
     * When startIdx === 0, the first message (chat_index -1) is prepended.
     */
    async function getPendingMessages() {
        if (currentCharIndex < 0 || currentChatIndex < 0) {
            return [];
        }
        try {
            const allMessages = await readChatMessagesRaw();
            await reconcileMessageLinks(allMessages);
            const startIdx = getLastSummarizedMsgIndex() + 1;
            let pending = [];
            // Prepend first message (chat_index -1) if we're starting from the beginning
            if (startIdx <= 0) {
                const firstMsg = await fetchFirstMessage();
                if (firstMsg)
                    pending.push(firstMsg);
            }
            for (const message of allMessages) {
                if (message.index >= Math.max(0, startIdx)) {
                    pending.push(message);
                }
            }
            // Apply regex only to pending subset
            pending = applyRegexToMessages(pending);
            return pending;
        }
        catch (e) {
            return [];
        }
    }
    function normalizeHypirkMemory(value) {
        if (!value || typeof value !== "object" || !value.id || typeof value.content !== "string")
            return null;
        const memory = {
            id: String(value.id),
            time: normalizeTimeString(typeof value.time === "string" ? value.time : ""),
            content: value.content,
            createdAt: Number.isFinite(value.createdAt) ? Number(value.createdAt) : Date.now(),
        };
        if (typeof value.category === "string" && value.category.trim())
            memory.category = value.category.trim();
        if (Array.isArray(value.tags))
            memory.tags = value.tags.filter((tag) => typeof tag === "string");
        if (Array.isArray(value.activationCues)) {
            const cues = value.activationCues
                .map((cue) => typeof cue === "string" ? cue.trim() : "")
                .filter((cue) => Boolean(cue));
            if (cues.length > 0)
                memory.activationCues = [...new Set(cues)];
        }
        if (value.favorite === true)
            memory.favorite = true;
        if (Number.isFinite(value.likedAt))
            memory.likedAt = Number(value.likedAt);
        if (value.translation && typeof value.translation.content === "string" &&
            typeof value.translation.targetLanguage === "string" && typeof value.translation.sourceHash === "string" &&
            Number.isFinite(value.translation.updatedAt)) {
            memory.translation = {
                content: value.translation.content,
                targetLanguage: value.translation.targetLanguage,
                sourceHash: value.translation.sourceHash,
                updatedAt: Number(value.translation.updatedAt),
                ...(typeof value.translation.model === "string" ? { model: value.translation.model } : {}),
                ...(value.translation.manuallyEdited === true ? { manuallyEdited: true } : {}),
            };
        }
        if (isFiniteEmbeddingVector(value.embedding))
            memory.embedding = value.embedding;
        if (typeof value.embeddingSourceHash === "string")
            memory.embeddingSourceHash = value.embeddingSourceHash;
        if (typeof value.embeddingConfigHash === "string")
            memory.embeddingConfigHash = value.embeddingConfigHash;
        if (Array.isArray(value.dialogueEmbeddingChildren)) {
            const children = value.dialogueEmbeddingChildren
                .filter((child) => child && typeof child.sourceHash === "string" && isFiniteEmbeddingVector(child.embedding))
                .map((child) => ({ sourceHash: child.sourceHash, embedding: child.embedding }));
            if (children.length > 0)
                memory.dialogueEmbeddingChildren = children;
        }
        if (typeof value.dialogueEmbeddingSourceHash === "string")
            memory.dialogueEmbeddingSourceHash = value.dialogueEmbeddingSourceHash;
        if (typeof value.dialogueEmbeddingConfigHash === "string")
            memory.dialogueEmbeddingConfigHash = value.dialogueEmbeddingConfigHash;
        return memory;
    }
    async function getDeviceLocalEmbeddingStorage() {
        if (localEmbeddingStorage !== undefined)
            return localEmbeddingStorage;
        try {
            localEmbeddingStorage = typeof risuai.getLocalPluginStorage === "function"
                ? await risuai.getLocalPluginStorage()
                : null;
        }
        catch (error) {
            console.log("[Hypirk] Local embedding storage is unavailable:", error);
            localEmbeddingStorage = null;
        }
        return localEmbeddingStorage;
    }
    function readLocalEmbeddingCacheEntry(value) {
        if (!value || typeof value !== "object")
            return null;
        const entry = {};
        if (isFiniteEmbeddingVector(value.embedding))
            entry.embedding = value.embedding;
        if (typeof value.embeddingSourceHash === "string")
            entry.embeddingSourceHash = value.embeddingSourceHash;
        if (typeof value.embeddingConfigHash === "string")
            entry.embeddingConfigHash = value.embeddingConfigHash;
        if (Array.isArray(value.dialogueEmbeddingChildren)) {
            const children = value.dialogueEmbeddingChildren
                .filter((child) => child && typeof child.sourceHash === "string" && isFiniteEmbeddingVector(child.embedding))
                .map((child) => ({ sourceHash: child.sourceHash, embedding: child.embedding }));
            if (children.length > 0)
                entry.dialogueEmbeddingChildren = children;
        }
        if (typeof value.dialogueEmbeddingSourceHash === "string")
            entry.dialogueEmbeddingSourceHash = value.dialogueEmbeddingSourceHash;
        if (typeof value.dialogueEmbeddingConfigHash === "string")
            entry.dialogueEmbeddingConfigHash = value.dialogueEmbeddingConfigHash;
        return Object.keys(entry).length > 0 ? entry : null;
    }
    function captureLocalEmbeddingCacheEntry(memory) {
        return readLocalEmbeddingCacheEntry(memory);
    }
    function sanitizeTranslationViewCache(value) {
        if (!value || typeof value !== "object")
            return {};
        const clean = {};
        for (const [key, raw] of Object.entries(value)) {
            if (!raw || typeof raw !== "object" || typeof raw.sourceHash !== "string")
                continue;
            const translated = typeof raw.value === "string"
                ? cleanChunkMessageDisplay(raw.value)
                : null;
            clean[key] = {
                sourceHash: raw.sourceHash,
                value: translated || null,
                checkedAt: Number.isFinite(raw.checkedAt) ? Number(raw.checkedAt) : Date.now(),
            };
        }
        return clean;
    }
    function applyLocalEmbeddingCacheEntry(memory, entry) {
        if (entry.embedding)
            memory.embedding = entry.embedding;
        if (entry.embeddingSourceHash)
            memory.embeddingSourceHash = entry.embeddingSourceHash;
        if (entry.embeddingConfigHash)
            memory.embeddingConfigHash = entry.embeddingConfigHash;
        if (entry.dialogueEmbeddingChildren)
            memory.dialogueEmbeddingChildren = entry.dialogueEmbeddingChildren;
        if (entry.dialogueEmbeddingSourceHash)
            memory.dialogueEmbeddingSourceHash = entry.dialogueEmbeddingSourceHash;
        if (entry.dialogueEmbeddingConfigHash)
            memory.dialogueEmbeddingConfigHash = entry.dialogueEmbeddingConfigHash;
    }
    function buildLocalEmbeddingCacheRecord(charId, chatId) {
        const memories = {};
        for (const memory of getNodes()) {
            const entry = captureLocalEmbeddingCacheEntry(memory);
            if (entry)
                memories[memory.id] = entry;
        }
        return {
            format: "hypirk-local-embedding-cache",
            schemaVersion: 1,
            charId,
            chatId,
            memories,
            updatedAt: Date.now(),
        };
    }
    function buildLocalDerivedCacheRecord(charId, chatId) {
        return {
            format: "hypirk-local-derived-cache", schemaVersion: 1, charId, chatId,
            translationViewCache: sanitizeTranslationViewCache(state.translationViewCache),
            lastNodeScores: { ...(state.lastNodeScores ?? {}) },
            lastChosenNodeIds: [...(state.lastChosenNodeIds ?? [])],
            lastRecentNodeIds: [...(state.lastRecentNodeIds ?? [])],
        };
    }
    async function flushLocalDerivedCacheForChat(charId, chatId) {
        const ownerState = state;
        const storage = await getDeviceLocalEmbeddingStorage();
        if (state !== ownerState) return false;
        if (!storage) return false;
        const revision = localDerivedCacheRevision;
        try {
            // Keep an empty record: it supersedes legacy fields after clearing badges.
            await storage.setItem(getLocalDerivedCacheKey(charId, chatId), buildLocalDerivedCacheRecord(charId, chatId));
            if (state === ownerState && revision === localDerivedCacheRevision)
                localDerivedCacheDirty = false;
            return true;
        }
        catch (error) {
            console.log("[Hypirk] Failed to save derived cache:", error);
            return false;
        }
    }
    function createPersistableStateWithoutEmbeddingCache() {
        const persistable = {
            ...state,
            entries: state.entries.map(entry => {
                const memory = entry.memory ? { ...entry.memory } : null;
                if (memory)
                    removeEmbeddingCacheFields(memory);
                return { memory, linkedMessages: [...entry.linkedMessages] };
            }),
        };
        delete persistable.translationViewCache;
        persistable.lastNodeScores = {};
        persistable.lastChosenNodeIds = [];
        persistable.lastRecentNodeIds = [];
        return persistable;
    }
    async function hydrateLocalEmbeddingCacheForChat(charId, chatId) {
        const storage = await getDeviceLocalEmbeddingStorage();
        if (!storage) return false;
        try {
            const [saved, derived] = await Promise.all([
                storage.getItem(getLocalEmbeddingCacheKey(charId, chatId)),
                storage.getItem(getLocalDerivedCacheKey(charId, chatId)),
            ]);
            const valid = saved?.format === "hypirk-local-embedding-cache" && saved.schemaVersion === 1 &&
                saved.charId === charId && saved.chatId === chatId && saved.memories && typeof saved.memories === "object";
            if (valid) {
                for (const memory of getNodes()) {
                    if (hasAnyEmbeddingCache(memory)) continue;
                    const entry = readLocalEmbeddingCacheEntry(saved.memories[memory.id]);
                    if (entry) applyLocalEmbeddingCacheEntry(memory, entry);
                }
            }
            const validDerived = derived?.format === "hypirk-local-derived-cache" && derived.schemaVersion === 1 &&
                derived.charId === charId && derived.chatId === chatId;
            const metadata = validDerived ? derived : valid ? saved : null;
            if (metadata) {
                if (!Object.keys(state.translationViewCache ?? {}).length)
                    state.translationViewCache = sanitizeTranslationViewCache(metadata.translationViewCache);
                if (!Object.keys(state.lastNodeScores ?? {}).length && metadata.lastNodeScores && typeof metadata.lastNodeScores === "object")
                    state.lastNodeScores = metadata.lastNodeScores;
                if (!state.lastChosenNodeIds?.length && Array.isArray(metadata.lastChosenNodeIds))
                    state.lastChosenNodeIds = metadata.lastChosenNodeIds.filter(id => typeof id === "string");
                if (!state.lastRecentNodeIds?.length && Array.isArray(metadata.lastRecentNodeIds))
                    state.lastRecentNodeIds = metadata.lastRecentNodeIds.filter(id => typeof id === "string");
            }
            if (valid && ["translationViewCache", "lastNodeScores", "lastChosenNodeIds", "lastRecentNodeIds"].some(key => key in saved)) {
                // Migrate only after both sidecars have been successfully written.
                markDerivedCacheDirty();
                markEmbeddingCacheDirty();
            }
            return true;
        }
        catch (error) {
            console.log("[Hypirk] Failed to load local embedding cache:", error);
            return false;
        }
    }
    async function flushLocalEmbeddingCacheForChat(charId, chatId) {
        const ownerState = state;
        const storage = await getDeviceLocalEmbeddingStorage();
        if (state !== ownerState) return false;
        if (!storage)
            return false;
        try {
            const key = getLocalEmbeddingCacheKey(charId, chatId);
            const revision = localEmbeddingCacheRevision;
            const record = buildLocalEmbeddingCacheRecord(charId, chatId);
            if (Object.keys(record.memories).length > 0)
                await storage.setItem(key, record);
            else
                await storage.removeItem(key);
            if (state === ownerState && revision === localEmbeddingCacheRevision)
                localEmbeddingCacheDirty = false;
            return true;
        }
        catch (error) {
            console.log("[Hypirk] Failed to save local embedding cache:", error);
            return false;
        }
    }
    async function loadStateForChat(charId, chatId) {
        await flushInlineCardChanges();
        const key = getStorageKey(charId, chatId);
        stateLoadFailed = false;
        localEmbeddingCacheDirty = false;
        localDerivedCacheDirty = false;
        let anchorsBackfilled = 0;
        let ownerIdentityMatched = true;
        try {
            await ensureCompactRetrievalLedgerLoaded();
            let saved = await risuai.pluginStorage.getItem(key);
            let migrated = false;
            if (saved) {
                const parsed = validateBackupData(saved);
                if (parsed) {
                    const next = createEmptyState();
                    next.entries = parsed.data.entries;
                    next.messages = parsed.data.messages ?? {};
                    next.lastNodeScores = saved.lastNodeScores && typeof saved.lastNodeScores === "object" ? saved.lastNodeScores : {};
                    next.lastChosenNodeIds = Array.isArray(saved.lastChosenNodeIds) ? saved.lastChosenNodeIds : [];
                    next.lastRecentNodeIds = Array.isArray(saved.lastRecentNodeIds) ? saved.lastRecentNodeIds : [];
                    next.regexRuleIds = Array.isArray(saved.regexRuleIds) ? saved.regexRuleIds.filter((id) => typeof id === "string") : [];
                    next.summarizerNote = typeof saved.summarizerNote === "string" ? saved.summarizerNote : "";
                    next.ownerCharId = typeof saved.ownerCharId === "string" ? saved.ownerCharId : charId;
                    next.ownerChatId = typeof saved.ownerChatId === "string" ? saved.ownerChatId : chatId;
                    next.ownerCharName = typeof saved.ownerCharName === "string" ? saved.ownerCharName : undefined;
                    next.ownerChatName = typeof saved.ownerChatName === "string" ? saved.ownerChatName : undefined;
                    const savedHashRecoveryFlag = typeof saved.hashRecoveryEnabled === "boolean"
                        ? saved.hashRecoveryEnabled
                        : null;
                    next.hashRecoveryEnabled = savedHashRecoveryFlag !== null
                        ? savedHashRecoveryFlag
                        : Object.values(next.messages).some((record) => isMessageAnchor(record?.anchor));
                    if (savedHashRecoveryFlag === null)
                        migrated = true;
                    if (Number.isFinite(saved.hashRecoveryActivatedAt)) {
                        next.hashRecoveryActivatedAt = Number(saved.hashRecoveryActivatedAt);
                    }
                    if (Number.isFinite(saved.lastVerifiedSummarizedIndex))
                        next.lastVerifiedSummarizedIndex = Number(saved.lastVerifiedSummarizedIndex);
                    next.translationViewCache = saved.translationViewCache && typeof saved.translationViewCache === "object" ? saved.translationViewCache : {};
                    next.translationVisibleNodeIds = Array.isArray(saved.translationVisibleNodeIds) ? saved.translationVisibleNodeIds : [];
                    next.autoSummaryPending = saved.autoSummaryPending === true;
                    if (saved.autoSummaryLastUsage &&
                        Number.isFinite(saved.autoSummaryLastUsage.inputTokens) &&
                        Number.isFinite(saved.autoSummaryLastUsage.maxContext) &&
                        Number.isFinite(saved.autoSummaryLastUsage.maxResponse) &&
                        Number.isFinite(saved.autoSummaryLastUsage.inputBudget)) {
                        next.autoSummaryLastUsage = {
                            inputTokens: Number(saved.autoSummaryLastUsage.inputTokens),
                            maxContext: Number(saved.autoSummaryLastUsage.maxContext),
                            maxResponse: Number(saved.autoSummaryLastUsage.maxResponse),
                            inputBudget: Number(saved.autoSummaryLastUsage.inputBudget),
                            pressureRatio: Number.isFinite(saved.autoSummaryLastUsage.pressureRatio)
                                ? Number(saved.autoSummaryLastUsage.pressureRatio)
                                : Number(saved.autoSummaryLastUsage.inputTokens) / Math.max(1, Number(saved.autoSummaryLastUsage.inputBudget)),
                            measuredAt: Number.isFinite(saved.autoSummaryLastUsage.measuredAt)
                                ? Number(saved.autoSummaryLastUsage.measuredAt)
                                : Date.now(),
                            fetchLogKey: String(saved.autoSummaryLastUsage.fetchLogKey ?? ""),
                        };
                    }
                    if (typeof saved.autoSummaryLastFetchLogKey === "string")
                        next.autoSummaryLastFetchLogKey = saved.autoSummaryLastFetchLogKey;
                    state = next;
                }
                else {
                    throw new Error("저장된 MemoryEntry 데이터 형식이 올바르지 않습니다.");
                }
                const rawEmbeddedTranslationCache = state.translationViewCache ?? {};
                state.translationViewCache = sanitizeTranslationViewCache(rawEmbeddedTranslationCache);
                const hadEmbeddedTranslationCache = Object.keys(state.translationViewCache).length > 0;
                const hadEmbeddedRetrievalUi = Object.keys(state.lastNodeScores ?? {}).length > 0 ||
                    state.lastChosenNodeIds.length > 0 ||
                    state.lastRecentNodeIds.length > 0;
                if (JSON.stringify(rawEmbeddedTranslationCache) !== JSON.stringify(state.translationViewCache)) {
                    migrated = true;
                }
                const hadEmbeddedCache = getNodes().some(hasAnyEmbeddingCache);
                const localCacheAvailable = await hydrateLocalEmbeddingCacheForChat(charId, chatId);
                if ((hadEmbeddedCache || hadEmbeddedTranslationCache || hadEmbeddedRetrievalUi) && localCacheAvailable) {
                    // The next save writes the cache sidecar first, then removes cache fields
                    // from the syncable state. On local-write failure saveStateForChat keeps
                    // the embedded fields as a lossless fallback.
                    markEmbeddingCacheDirty();
                    markDerivedCacheDirty();
                    migrated = true;
                }
                const hasStoredOwner = Boolean(state.ownerCharId || state.ownerChatId);
                ownerIdentityMatched =
                    !hasStoredOwner ||
                        (state.ownerCharId === charId && state.ownerChatId === chatId);
                linkRecoveryIdentityConfirmed = ownerIdentityMatched;
                if (!hasStoredOwner) {
                    state.ownerCharId = charId;
                    state.ownerChatId = chatId;
                    migrated = true;
                }
                if (refreshStateOwnerNames(charId, chatId))
                    migrated = true;
                for (const memory of getNodes()) {
                    if (!Array.isArray(memory.tags))
                        memory.tags = [];
                    if (memory.likedAt !== undefined && !Number.isFinite(memory.likedAt)) {
                        delete memory.likedAt;
                        migrated = true;
                    }
                    if (memory.embedding !== undefined &&
                        (!isFiniteEmbeddingVector(memory.embedding) ||
                            typeof memory.embeddingSourceHash !== "string" || typeof memory.embeddingConfigHash !== "string")) {
                        clearNodeEmbedding(memory);
                        migrated = true;
                    }
                }
                const currentMessages = await readChatMessagesRaw();
                if (linkRecoveryIdentityConfirmed) {
                    if (state.hashRecoveryEnabled === true) {
                        anchorsBackfilled = await backfillMessageAnchors(currentMessages);
                        if (anchorsBackfilled > 0)
                            migrated = true;
                    }
                    pushSetFullChatDebug("state-loaded", {
                        hashRecoveryEnabled: state.hashRecoveryEnabled === true,
                        hashRecoveryActivatedAt: state.hashRecoveryActivatedAt ?? null,
                        messageRecordCount: Object.keys(state.messages).length,
                        anchoredRecordCount: Object.values(state.messages).filter(record => record.anchor !== null).length,
                    });
                    await reconcileMessageLinks(currentMessages);
                }
                else {
                    currentLinkHealthStatus = "identity-mismatch";
                    linkFallbackBoundaryAllowed = false;
                }
                if (migrated)
                    await saveStateForChat(charId, chatId);
            }
            else {
                state = createEmptyState();
                state.ownerCharId = charId;
                state.ownerChatId = chatId;
                refreshStateOwnerNames(charId, chatId);
                state.hashRecoveryEnabled = false;
                linkRecoveryIdentityConfirmed = true;
                currentLinkHealthStatus = "no-links";
                linkFallbackBoundaryAllowed = false;
                pushSetFullChatDebug("state-created", { hashRecoveryEnabled: false });
            }
        }
        catch (e) {
            stateLoadFailed = true;
            console.log("[Hypirk] Failed to load chat state:", e);
            state = createEmptyState();
            state.ownerCharId = charId;
            state.ownerChatId = chatId;
            refreshStateOwnerNames(charId, chatId);
            state.hashRecoveryEnabled = false;
            linkRecoveryIdentityConfirmed = true;
            currentLinkHealthStatus = "no-links";
            linkFallbackBoundaryAllowed = false;
        }
    }
    let chatStateSaveQueue = Promise.resolve();
    function saveStateForChat(charId, chatId) {
        const ownerState = state;
        const task = chatStateSaveQueue.then(() => {
            if (state !== ownerState || currentCharId !== charId || currentChatId !== chatId) {
                console.log("[Hypirk] Discarded superseded save job.");
                return;
            }
            return persistStateForChat(charId, chatId);
        });
        chatStateSaveQueue = task.catch(() => {});
        return task;
    }
    async function persistStateForChat(charId, chatId) {
        const savingState = state;
        if (stateLoadFailed)
            throw new Error("저장 데이터 오류: 정상 백업을 불러온 후 저장할 수 있습니다.");
        const key = getStorageKey(charId, chatId);
        try {
            // Names are labels only. Stable IDs continue to own the state and prevent
            // collisions; update labels only when the detected context matches.
            refreshStateOwnerNames(charId, chatId);
            const usedSlots = new Set([...state.entries, ...(summarizationPreviewEntry ? [summarizationPreviewEntry] : [])].flatMap(entry => entry.linkedMessages));
            state.messages = Object.fromEntries(Object.entries(state.messages).filter(([slot]) => usedSlots.has(Number(slot))));
            const localStorageAvailable = Boolean(await getDeviceLocalEmbeddingStorage());
            if (state !== savingState) return;
            // Derived metadata must reach storage before stripping legacy vector records.
            const derivedSaved = !localDerivedCacheDirty || await flushLocalDerivedCacheForChat(charId, chatId);
            if (state !== savingState) return;
            const vectorsSaved = derivedSaved && (!localEmbeddingCacheDirty || await flushLocalEmbeddingCacheForChat(charId, chatId));
            const localCacheSaved = derivedSaved && vectorsSaved && !localDerivedCacheDirty && !localEmbeddingCacheDirty;
            if (state !== savingState) return;
            const persistableState = localStorageAvailable && localCacheSaved
                ? createPersistableStateWithoutEmbeddingCache()
                : state;
            await risuai.pluginStorage.setItem(key, persistableState);
        }
        catch (e) {
            console.log("[Hypirk] Failed to save chat state:", e);
            throw e;
        }
    }
    async function loadState() {
        // Load global prompt
        try {
            const savedPrompt = await risuai.pluginStorage.getItem(PROMPT_STORAGE_KEY);
            if (savedPrompt) {
                summaryPrompt = savedPrompt;
            }
        }
        catch (_) {
            /* use default */
        }
        // Load persisted settings (survives plugin updates)
        try {
            const savedSettings = await risuai.pluginStorage.getItem(SETTINGS_STORAGE_KEY);
            if (savedSettings) {
                if (savedSettings.chunkSize !== undefined)
                    chunkSize = savedSettings.chunkSize;
                if (Number.isFinite(savedSettings.retainedMessagesAfterSummary) && savedSettings.retainedMessagesAfterSummary >= 0)
                    retainedMessagesAfterSummary = Math.floor(savedSettings.retainedMessagesAfterSummary);
                if (savedSettings.maxMemoryTokens !== undefined)
                    maxMemoryTokens = savedSettings.maxMemoryTokens;
                if (savedSettings.embeddingUrl !== undefined)
                    embeddingUrl = savedSettings.embeddingUrl;
                if (savedSettings.embeddingModel !== undefined)
                    embeddingModel = savedSettings.embeddingModel;
                if (savedSettings.embeddingApiKey !== undefined)
                    embeddingApiKey = savedSettings.embeddingApiKey;
                dialogueLocalWeight = normalizeRetrievalWeight(savedSettings.dialogueLocalWeight, dialogueLocalWeight);
                dialogueEmbeddingWeight = normalizeRetrievalWeight(savedSettings.dialogueEmbeddingWeight, dialogueEmbeddingWeight);
                activationCueWeight = normalizeRetrievalWeight(savedSettings.activationCueWeight, activationCueWeight);
                likeBonusBase = normalizeRetrievalWeight(savedSettings.likeBonusBase, likeBonusBase);
                if (savedSettings.includeUserMessages !== undefined)
                    includeUserMessages = savedSettings.includeUserMessages;
                if (savedSettings.embeddingContextMessages !== undefined)
                    embeddingContextMessages = savedSettings.embeddingContextMessages;
                if (Number.isFinite(savedSettings.queryParagraphGroupSize) &&
                    savedSettings.queryParagraphGroupSize >= 1) {
                    queryParagraphGroupSize = Math.floor(savedSettings.queryParagraphGroupSize);
                }
                if (typeof savedSettings.recentMemoryRatio === "number" &&
                    Number.isFinite(savedSettings.recentMemoryRatio) &&
                    savedSettings.recentMemoryRatio >= 0 &&
                    savedSettings.recentMemoryRatio <= 1) {
                    recentMemoryRatio = savedSettings.recentMemoryRatio;
                }
                if (typeof savedSettings.memoryInjectionAnchor === "string")
                    memoryInjectionAnchor = savedSettings.memoryInjectionAnchor;
                if (typeof savedSettings.memorySeparator === "string")
                    memorySeparator = savedSettings.memorySeparator;
                if (typeof savedSettings.lorebookSeparator === "string")
                    lorebookSeparator = savedSettings.lorebookSeparator;
                if (Number.isFinite(savedSettings.maxLorebookTokens) && savedSettings.maxLorebookTokens >= 0)
                    maxLorebookTokens = Math.floor(savedSettings.maxLorebookTokens);
                if (typeof savedSettings.memoryInjectionTemplate === "string")
                    memoryInjectionTemplate = savedSettings.memoryInjectionTemplate;
                if (typeof savedSettings.activeMemoryInjectionProfileId === "string")
                    activeMemoryInjectionProfileId = savedSettings.activeMemoryInjectionProfileId;
                if (isUiColorPreset(savedSettings.uiColorPreset))
                    uiColorPreset = savedSettings.uiColorPreset;
                if (READING_SCALE_PRESETS.includes(savedSettings.readingScale))
                    readingScale = savedSettings.readingScale;
                if (savedSettings.readingFontFamily === "sans" ||
                    savedSettings.readingFontFamily === "ridi_batang" ||
                    savedSettings.readingFontFamily === "bookk_myungjo") {
                    readingFontFamily = savedSettings.readingFontFamily;
                }
                else if (savedSettings.readingFontFamily === "serif") {
                    // Compatibility for 2-2 and earlier: the former generic serif choice
                    // becomes the closest supported replacement instead of resetting.
                    readingFontFamily = "ridi_batang";
                }
                if (typeof savedSettings.nodeTranslationApiUrl === "string")
                    nodeTranslationApiUrl = savedSettings.nodeTranslationApiUrl;
                if (typeof savedSettings.nodeTranslationApiKey === "string")
                    nodeTranslationApiKey = savedSettings.nodeTranslationApiKey;
                if (typeof savedSettings.nodeTranslationModel === "string")
                    nodeTranslationModel = savedSettings.nodeTranslationModel;
                if (typeof savedSettings.nodeTranslationLanguage === "string")
                    nodeTranslationLanguage = savedSettings.nodeTranslationLanguage;
                if (typeof savedSettings.nodeTranslationPrompt === "string")
                    nodeTranslationPrompt = savedSettings.nodeTranslationPrompt;
                if (Number.isFinite(savedSettings.nodeTranslationMaxTokens))
                    nodeTranslationMaxTokens = savedSettings.nodeTranslationMaxTokens;
                if (Number.isFinite(savedSettings.nodeTranslationTemperature))
                    nodeTranslationTemperature = savedSettings.nodeTranslationTemperature;
                if (typeof savedSettings.debugMode === "boolean")
                    debugMode = savedSettings.debugMode;
                if (savedSettings.nodeSortDirection === "asc" || savedSettings.nodeSortDirection === "desc" || savedSettings.nodeSortDirection === "tokens-desc")
                    nodeSortDirection = savedSettings.nodeSortDirection;
                if (savedSettings.nodesPerPage === 10 || savedSettings.nodesPerPage === 20 || savedSettings.nodesPerPage === 30)
                    nodesPerPage = savedSettings.nodesPerPage;
                if (typeof savedSettings.activeSummaryPresetName === "string")
                    activeSummaryPresetName = savedSettings.activeSummaryPresetName;
            }
        }
        catch (_) {
            /* ignore */
        }
        // The active summary preset is the source of truth for preset-owned settings.
        // Older presets may lack newly added fields; applyPreset() preserves the
        // already-loaded setting for any field that is absent.
        if (activeSummaryPresetName) {
            try {
                const presets = await loadPresets();
                const activePreset = presets.find((preset) => preset.name === activeSummaryPresetName);
                if (activePreset) {
                    applyPreset(activePreset);
                }
                else {
                    activeSummaryPresetName = "";
                }
            }
            catch (_) {
                /* keep the persisted standalone settings */
            }
        }
        // Injection profiles are independent from summary presets.
        await loadMemoryInjectionProfiles();
        applyInitialMemoryInjectionProfileSelection();
        // Detect current chat and load its state (may fail if no chat is open)
        try {
            const { charIndex, chatIndex, charId, chatId } = await detectCurrentChat();
            currentCharIndex = charIndex;
            currentChatIndex = chatIndex;
            currentCharId = charId;
            currentChatId = chatId;
            await loadStateForChat(charId, chatId);
            await loadCharacterTimelineSettings(charId);
        }
        catch (e) {
            state = createEmptyState();
            currentCharacterTimelineSettings = createDefaultCharacterTimelineSettings();
        }
        // Load shared Hypirk regex library.
        await loadRegexLibrary();
    }
    async function saveState() {
        if (currentCharId && currentChatId) {
            await saveStateForChat(currentCharId, currentChatId);
        }
    }
    async function savePrompt() {
        await risuai.pluginStorage.setItem(PROMPT_STORAGE_KEY, summaryPrompt);
    }
    async function saveSettings() {
        await risuai.pluginStorage.setItem(SETTINGS_STORAGE_KEY, {
            chunkSize,
            retainedMessagesAfterSummary,
            maxMemoryTokens,
            embeddingUrl,
            embeddingModel,
            embeddingApiKey,
            dialogueLocalWeight,
            dialogueEmbeddingWeight,
            activationCueWeight,
            likeBonusBase,
            includeUserMessages,
            embeddingContextMessages,
            queryParagraphGroupSize,
            recentMemoryRatio,
            memoryInjectionAnchor,
            memoryInjectionTemplate,
            activeMemoryInjectionProfileId,
            memorySeparator,
            lorebookSeparator,
            maxLorebookTokens,
            uiColorPreset,
            readingScale,
            readingFontFamily,
            nodeTranslationApiUrl,
            nodeTranslationApiKey,
            nodeTranslationModel,
            nodeTranslationLanguage,
            nodeTranslationPrompt,
            nodeTranslationMaxTokens,
            nodeTranslationTemperature,
            debugMode,
            nodeSortDirection,
            nodesPerPage,
            activeSummaryPresetName,
        });
    }
    // ── Main-model memory injection profiles ───────────────────────────────
    function makeMemoryInjectionProfileId() {
        return typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `injection-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    function normalizeMemoryInjectionNamespace(value) {
        return typeof value === "string" ? value.trim() : "";
    }
    function memoryInjectionProfileLabel(namespace) {
        return normalizeMemoryInjectionNamespace(namespace) || "네임스페이스 없음(기본 fallback)";
    }
    function sanitizeMemoryInjectionProfiles(value) {
        if (!Array.isArray(value))
            return [];
        const byNamespace = new Map();
        for (const raw of value) {
            if (!raw || typeof raw !== "object")
                continue;
            const namespace = normalizeMemoryInjectionNamespace(raw.namespace);
            const profile = {
                id: typeof raw.id === "string" && raw.id
                    ? raw.id
                    : makeMemoryInjectionProfileId(),
                namespace,
                anchor: typeof raw.anchor === "string" ? raw.anchor : DEFAULT_MEMORY_INJECTION_ANCHOR,
                template: typeof raw.template === "string" ? raw.template : DEFAULT_MEMORY_INJECTION_TEMPLATE,
            };
            byNamespace.set(namespace, profile);
        }
        return [...byNamespace.values()];
    }
    async function loadMemoryInjectionProfiles() {
        try {
            const saved = await risuai.pluginStorage.getItem(MEMORY_INJECTION_PROFILES_STORAGE_KEY);
            if (Array.isArray(saved)) {
                memoryInjectionProfilesCache = sanitizeMemoryInjectionProfiles(saved);
                return memoryInjectionProfilesCache;
            }
        }
        catch (_) {
            /* fall through to one-time migration */
        }
        // 2-4 and earlier stored one global anchor/template. Preserve those values
        // as the initial empty-namespace fallback profile.
        const migratedFallback = {
            id: makeMemoryInjectionProfileId(),
            namespace: "",
            anchor: memoryInjectionAnchor,
            template: memoryInjectionTemplate,
        };
        memoryInjectionProfilesCache = [migratedFallback];
        try {
            await risuai.pluginStorage.setItem(MEMORY_INJECTION_PROFILES_STORAGE_KEY, memoryInjectionProfilesCache);
        }
        catch (_) {
            /* keep the in-memory fallback */
        }
        return memoryInjectionProfilesCache;
    }
    async function saveMemoryInjectionProfiles() {
        memoryInjectionProfilesCache = sanitizeMemoryInjectionProfiles(memoryInjectionProfilesCache);
        await risuai.pluginStorage.setItem(MEMORY_INJECTION_PROFILES_STORAGE_KEY, memoryInjectionProfilesCache);
    }
    function applyMemoryInjectionProfile(profile) {
        memoryInjectionNamespace = normalizeMemoryInjectionNamespace(profile.namespace);
        memoryInjectionAnchor = profile.anchor;
        memoryInjectionTemplate = profile.template;
    }
    function applyInitialMemoryInjectionProfileSelection() {
        memoryInjectionDraft = null;
        let profile = memoryInjectionProfilesCache.find((item) => item.id === activeMemoryInjectionProfileId);
        if (!profile) {
            profile = memoryInjectionProfilesCache.find((item) => normalizeMemoryInjectionNamespace(item.namespace) === "") ?? memoryInjectionProfilesCache[0];
        }
        if (profile) {
            activeMemoryInjectionProfileId = profile.id;
            applyMemoryInjectionProfile(profile);
            return;
        }
        activeMemoryInjectionProfileId = "";
        memoryInjectionNamespace = "";
        memoryInjectionAnchor = DEFAULT_MEMORY_INJECTION_ANCHOR;
        memoryInjectionTemplate = DEFAULT_MEMORY_INJECTION_TEMPLATE;
    }
    async function detectPromptNamespace() {
        try {
            // The namespace probe confirmed this request-independent DB field exposes
            // the effective prompt namespace used by Risu's prompt/module integration.
            // Hypirk intentionally does not inspect module objects or module namespaces.
            const db = await risuai.getDatabase(["moduleIntergration"]);
            const value = db?.moduleIntergration;
            if (typeof value !== "string")
                return null;
            const namespace = value.trim();
            return namespace || null;
        }
        catch (error) {
            console.warn("[Hypirk] Prompt namespace lookup failed; using fallback injection profile", error);
            return null;
        }
    }
    function resolveMemoryInjectionProfileForNamespace(namespace) {
        const normalized = normalizeMemoryInjectionNamespace(namespace);
        if (normalized) {
            const matched = memoryInjectionProfilesCache.find((profile) => normalizeMemoryInjectionNamespace(profile.namespace) === normalized);
            if (matched)
                return matched;
        }
        return memoryInjectionProfilesCache.find((profile) => normalizeMemoryInjectionNamespace(profile.namespace) === "") ?? {
            id: "__builtin_fallback__",
            namespace: "",
            anchor: DEFAULT_MEMORY_INJECTION_ANCHOR,
            template: DEFAULT_MEMORY_INJECTION_TEMPLATE,
        };
    }
    // ── Presets ──────────────────────────────────────────────────────────────
    async function loadPresets() {
        try {
            const saved = await risuai.pluginStorage.getItem(PRESETS_STORAGE_KEY);
            if (saved && Array.isArray(saved)) {
                return saved.map((preset) => ({
                    ...preset,
                    eventFormat: normalizeContentOnlyEventFormat(preset?.eventFormat),
                }));
            }
        }
        catch (_) {
            /* ignore */
        }
        return [];
    }
    async function savePresets(presets) {
        await risuai.pluginStorage.setItem(PRESETS_STORAGE_KEY, presets);
    }
    async function updateActivePresetFields(updates) {
        if (!activeSummaryPresetName)
            return;
        const presets = await loadPresets();
        const index = presets.findIndex((preset) => preset.name === activeSummaryPresetName);
        if (index < 0)
            return;
        presets[index] = { ...presets[index], ...updates, name: activeSummaryPresetName };
        await savePresets(presets);
    }
    function createAutomaticPresetName(presets) {
        let index = 1;
        while (presets.some((preset) => preset.name === `New Preset ${index}`)) {
            index += 1;
        }
        return `New Preset ${index}`;
    }
    function createCopiedPresetName(sourceName, presets) {
        let index = 1;
        let candidate = `${sourceName} (${index})`;
        while (presets.some((preset) => preset.name === candidate)) {
            index += 1;
            candidate = `${sourceName} (${index})`;
        }
        return candidate;
    }
    function createNewPreset(presets) {
        return {
            name: createAutomaticPresetName(presets),
            summaryPrompt: NEW_PRESET_SUMMARY_PROMPT,
            chunkSize: NEW_PRESET_CHUNK_SIZE,
            retainedMessagesAfterSummary: NEW_PRESET_RETAINED_MESSAGES_AFTER_SUMMARY,
            includeUserMessages: false,
            embeddingContextMessages: NEW_PRESET_EMBEDDING_CONTEXT_MESSAGES,
            eventFormat: NEW_PRESET_EVENT_FORMAT,
            memorySeparator: NEW_PRESET_MEMORY_SEPARATOR,
            maxMemoryTokens: NEW_PRESET_MAX_MEMORY_TOKENS,
            recentMemoryRatio: NEW_PRESET_RECENT_MEMORY_RATIO,
        };
    }
    function currentSettingsAsPreset() {
        return {
            name: "",
            summaryPrompt,
            chunkSize,
            retainedMessagesAfterSummary,
            includeUserMessages,
            embeddingContextMessages,
            eventFormat,
            memorySeparator,
            maxMemoryTokens,
            recentMemoryRatio,
        };
    }
    function applyPreset(p) {
        summaryPrompt = p.summaryPrompt;
        chunkSize = p.chunkSize;
        if (Number.isFinite(p.retainedMessagesAfterSummary) && (p.retainedMessagesAfterSummary ?? -1) >= 0)
            retainedMessagesAfterSummary = Math.floor(p.retainedMessagesAfterSummary);
        includeUserMessages = p.includeUserMessages;
        embeddingContextMessages = p.embeddingContextMessages;
        if (p.eventFormat !== undefined)
            eventFormat = normalizeContentOnlyEventFormat(p.eventFormat);
        if (typeof p.memorySeparator === "string")
            memorySeparator = p.memorySeparator;
        if (Number.isFinite(p.maxMemoryTokens) && (p.maxMemoryTokens ?? 0) > 0)
            maxMemoryTokens = Math.floor(p.maxMemoryTokens);
        if (typeof p.recentMemoryRatio === "number" &&
            Number.isFinite(p.recentMemoryRatio) &&
            p.recentMemoryRatio >= 0 &&
            p.recentMemoryRatio <= 1) {
            recentMemoryRatio = p.recentMemoryRatio;
        }
    }
    function parseRisuPreset(json) {
        try {
            const data = JSON.parse(json);
            if (data?.type !== "risu" || !data?.data?.settings)
                return null;
            const s = data.data.settings;
            return {
                name: data.data.name || "Imported Preset",
                summaryPrompt: s.summarizationPrompt || "",
                chunkSize: s.maxChatsPerSummary || DEFAULT_CHUNK_SIZE,
                retainedMessagesAfterSummary: NEW_PRESET_RETAINED_MESSAGES_AFTER_SUMMARY,
                includeUserMessages: !s.doNotSummarizeUserMessage,
                embeddingContextMessages: s.queryChatCount || NEW_PRESET_EMBEDDING_CONTEXT_MESSAGES,
                eventFormat: NEW_PRESET_EVENT_FORMAT,
                memorySeparator: NEW_PRESET_MEMORY_SEPARATOR,
                maxMemoryTokens: NEW_PRESET_MAX_MEMORY_TOKENS,
                recentMemoryRatio: NEW_PRESET_RECENT_MEMORY_RATIO,
            };
        }
        catch (_) {
            return null;
        }
    }
    /** Download JSON data with current character/chat names in the filename. */
    async function downloadJsonFile(data, filenamePrefix, exactFilename) {
        let charName = `char_${currentCharIndex}`;
        let chatName = `chat_${currentChatIndex}`;
        try {
            const char = await risuai.getCharacterFromIndex(currentCharIndex);
            if (char && char.name)
                charName = char.name;
        }
        catch (_) { }
        try {
            const chat = await risuai.getChatFromIndex(currentCharIndex, currentChatIndex);
            if (chat && chat.name)
                chatName = chat.name;
        }
        catch (_) { }
        const exportedAt = new Date().toISOString();
        const json = JSON.stringify(data, null, 2);
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const safeCharName = charName.replace(/[\/:*?"<>|]/g, "_").replace(/\s+/g, "_");
        const safeChatName = chatName.replace(/[\/:*?"<>|]/g, "_").replace(/\s+/g, "_");
        const safeDate = exportedAt.replace(/[:.]/g, "-");
        const a = document.createElement("a");
        a.href = url;
        a.download = exactFilename ?? `${filenamePrefix}_${safeCharName}_${safeChatName}_${safeDate}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
    async function buildRetrievalDebugExport() {
        await ensureCompactRetrievalLedgerLoaded();
        return {
            format: "hypirk-compact-retrieval-history", schemaVersion: 1, exportedAt: new Date().toISOString(), delimiter: "|",
            fields: [
                "version", "wallClockMs", "character(id~name)", "chat(id~name)", "nodeId", "source(R|S)",
                "rank", "selected", "queryCount", "calendarDayRaw", "calendarAgeDays", "contentScore",
                "dialogueSemanticScore", "dialogueSemanticContribution", "dialogueLexicalScore",
                "dialogueLexicalContribution", "activationScore", "activationContribution", "likeBonus",
                "totalScore", "dialogueSemanticWeight", "dialogueLexicalWeight", "activationWeight", "likeBaseWeight",
            ],
            rows: [...compactRetrievalLedger],
        };
    }
    function buildHypirkBackup() {
        return {
            format: "hypirk",
            schemaVersion: 3,
            messages: JSON.parse(JSON.stringify(state.messages)),
            hashRecoveryEnabled: state.hashRecoveryEnabled === true,
            ...(Number.isFinite(state.hashRecoveryActivatedAt)
                ? { hashRecoveryActivatedAt: state.hashRecoveryActivatedAt }
                : {}),
            entries: state.entries.map(entry => {
                const memory = entry.memory;
                if (!memory)
                    return { memory: null, linkedMessages: [...entry.linkedMessages] };
                const record = {
                    id: memory.id,
                    time: memory.time,
                    content: memory.content,
                    createdAt: memory.createdAt,
                };
                if (memory.category)
                    record.category = memory.category;
                if (memory.tags?.length)
                    record.tags = [...memory.tags];
                if (memory.activationCues?.length)
                    record.activationCues = [...memory.activationCues];
                if (memory.favorite === true)
                    record.favorite = true;
                if (Number.isFinite(memory.likedAt))
                    record.likedAt = memory.likedAt;
                if (memory.translation)
                    record.translation = { ...memory.translation };
                return { memory: record, linkedMessages: [...entry.linkedMessages] };
            }),
        };
    }
    async function downloadBackup() {
        let charName = `char_${currentCharIndex}`;
        let chatName = `chat_${currentChatIndex}`;
        try {
            const char = await risuai.getCharacterFromIndex(currentCharIndex);
            if (char?.name)
                charName = char.name;
        }
        catch (_) { }
        try {
            const chat = await risuai.getChatFromIndex(currentCharIndex, currentChatIndex);
            if (chat?.name)
                chatName = chat.name;
        }
        catch (_) { }
        const now = new Date();
        const two = (value) => String(value).padStart(2, "0");
        const localStamp = `${two(now.getFullYear() % 100)}${two(now.getMonth() + 1)}${two(now.getDate())} ${two(now.getHours())}-${two(now.getMinutes())}-${two(now.getSeconds())}`;
        const safe = (value) => value.replace(/[\/:*?"<>|]/g, "_");
        await downloadJsonFile(buildHypirkBackup(), "hypirk_backup", `(${safe(charName)}) ${safe(chatName)} [HYPIRK ${localStamp}].json`);
    }
    /** Strict current schema only. Reject the entire file if any entry is invalid. */
    function parseBackupFile(json) {
        try { return validateBackupData(JSON.parse(json)); }
        catch (_) { return null; }
    }
    function validateBackupData(data) {
        try {
            if (data?.format !== "hypirk" || data.schemaVersion !== 3 || !Array.isArray(data.entries))
                return null;
            if (data.hashRecoveryEnabled !== undefined && typeof data.hashRecoveryEnabled !== "boolean")
                return null;
            if (data.hashRecoveryActivatedAt !== undefined && !Number.isFinite(data.hashRecoveryActivatedAt))
                return null;
            const ids = new Set();
            const entries = [];
            for (const entry of data.entries) {
                if (!entry || typeof entry !== "object" ||
                    Object.keys(entry).some(key => key !== "memory" && key !== "linkedMessages") ||
                    !Array.isArray(entry.linkedMessages) ||
                    !entry.linkedMessages.every((index) => Number.isSafeInteger(index) && Number(index) >= -1) ||
                    new Set(entry.linkedMessages).size !== entry.linkedMessages.length)
                    return null;
                let memory = null;
                if (entry.memory !== null) {
                    const raw = entry.memory;
                    if (!raw || typeof raw.id !== "string" || !raw.id || typeof raw.time !== "string" ||
                        typeof raw.content !== "string" || !Number.isFinite(raw.createdAt) || ids.has(raw.id))
                        return null;
                    // Current content-only memory fields only; retired structured-dialogue fields are handled by the converter.
                    const allowed = new Set(["id", "time", "content", "createdAt", "category", "tags", "activationCues", "favorite", "likedAt", "translation", "embedding", "embeddingSourceHash", "embeddingConfigHash", "dialogueEmbeddingChildren", "dialogueEmbeddingSourceHash", "dialogueEmbeddingConfigHash"]);
                    if (Object.keys(raw).some(key => !allowed.has(key)))
                        return null;
                    const stringList = (value) => Array.isArray(value) && value.every(item => typeof item === "string");
                    if ((raw.category !== undefined && typeof raw.category !== "string") ||
                        (raw.tags !== undefined && !stringList(raw.tags)) ||
                        (raw.activationCues !== undefined && !stringList(raw.activationCues)) ||
                        (raw.favorite !== undefined && typeof raw.favorite !== "boolean") ||
                        (raw.likedAt !== undefined && !Number.isFinite(raw.likedAt)))
                        return null;
                    if (raw.translation !== undefined && (!raw.translation || typeof raw.translation.content !== "string" ||
                        typeof raw.translation.targetLanguage !== "string" || typeof raw.translation.sourceHash !== "string" ||
                        !Number.isFinite(raw.translation.updatedAt) ||
                        Object.keys(raw.translation).some((key) => !["content", "targetLanguage", "sourceHash", "updatedAt", "model", "manuallyEdited"].includes(key))))
                        return null;
                    memory = normalizeHypirkMemory(raw);
                    if (!memory)
                        return null;
                    ids.add(memory.id);
                }
                entries.push({ memory, linkedMessages: [...entry.linkedMessages] });
            }
            const messages = {};
            if (data.messages !== undefined) {
                if (!data.messages || typeof data.messages !== "object" || Array.isArray(data.messages))
                    return null;
                const chatIds = new Set();
                for (const [key, value] of Object.entries(data.messages)) {
                    if (!Number.isSafeInteger(Number(key)) || Number(key) < -1 || String(Number(key)) !== key ||
                        !value || typeof value.chatId !== "string" || !value.chatId || chatIds.has(value.chatId) ||
                        !Number.isSafeInteger(value.index) || value.index < -1 ||
                        (value.anchor !== null && !isMessageAnchor(value.anchor)))
                        return null;
                    messages[key] = { chatId: value.chatId, index: value.index, anchor: value.anchor ? { ...value.anchor } : null };
                    chatIds.add(value.chatId);
                }
                if (entries.some(entry => entry.linkedMessages.some(slot => !messages[String(slot)])))
                    return null;
            }
            return { kind: "hypirk", data: { format: "hypirk", schemaVersion: 3, entries,
                    ...(data.messages === undefined ? {} : { messages }),
                    ...(typeof data.hashRecoveryEnabled === "boolean" ? { hashRecoveryEnabled: data.hashRecoveryEnabled } : {}),
                    ...(Number.isFinite(data.hashRecoveryActivatedAt) ? { hashRecoveryActivatedAt: Number(data.hashRecoveryActivatedAt) } : {}) } };
        }
        catch (_) {
            return null;
        }
    }
    /** Table-less current JSON uses current chat indices, resolved explicitly on import. */
    async function restoreFromBackup(backup) {
        await flushInlineCardChanges();
        const verified = validateBackupData(backup.data);
        if (!verified)
            throw new Error("형식이 올바르지 않습니다.");
        const raw = await readChatMessagesRaw();
        const nextEntries = verified.data.entries;
        const nextMessages = verified.data.messages ?? {};
        if (!verified.data.messages) {
            for (const slot of new Set(nextEntries.flatMap(entry => entry.linkedMessages))) {
                const first = slot === -1 ? await fetchFirstMessage() : null;
                const message = slot === -1 && first ? { ...first, chatId: FIRST_MESSAGE_CHAT_ID, index: -1 } : raw.find(message => message.index === slot);
                if (!message)
                    throw new Error(`연결 메시지 #${slot}을 현재 채팅에서 찾을 수 없습니다.`);
                nextMessages[String(slot)] = { chatId: message.chatId, index: slot,
                    anchor: verified.data.hashRecoveryEnabled === true && slot !== -1
                        ? await createMessageAnchor(message)
                        : null };
            }
        }
        state.entries = nextEntries;
        state.messages = nextMessages;
        stateLoadFailed = false;
        state.ownerCharId = currentCharId;
        state.ownerChatId = currentChatId;
        state.hashRecoveryEnabled = typeof verified.data.hashRecoveryEnabled === "boolean"
            ? verified.data.hashRecoveryEnabled
            : Object.values(nextMessages).some(record => record.anchor !== null);
        state.hashRecoveryActivatedAt = Number.isFinite(verified.data.hashRecoveryActivatedAt)
            ? Number(verified.data.hashRecoveryActivatedAt)
            : undefined;
        linkRecoveryIdentityConfirmed = true;
        state.lastNodeScores = {};
        state.lastChosenNodeIds = [];
        state.lastRecentNodeIds = [];
        state.translationVisibleNodeIds = [];
        markEmbeddingCacheDirty();
        markDerivedCacheDirty();
        await reconcileMessageLinks(raw);
        if (state.hashRecoveryEnabled === true)
            await backfillMessageAnchors(raw);
        await saveState();
        return "hypirk";
    }
    function countQueryParagraphs(text) {
        const normalized = String(text ?? "").replace(/\r\n?/g, "\n").trim();
        if (!normalized)
            return 0;
        return normalized
            .split(/\n\s*\n+/)
            .map((part) => part.trim())
            .filter(Boolean)
            .length;
    }
    /**
     * Query Separate: keep each Memory as one cached vector, but split recent chat
     * into weighted query fragments. Adjacent paragraphs are grouped so the user
     * can trade granularity for per-turn embedding request size.
     */
    function buildWeightedEmbeddingQueries(messages) {
        const weighted = [];
        const messageCount = messages.length;
        if (messageCount === 0)
            return weighted;
        const groupSize = Math.max(1, Math.floor(queryParagraphGroupSize));
        for (let messageIndex = 0; messageIndex < messageCount; messageIndex++) {
            const message = messages[messageIndex];
            const paragraphs = message.text
                .split(/\n\s*\n+/)
                .map((text) => normalizeEmbeddingWhitespace(text))
                .filter(Boolean);
            if (paragraphs.length === 0)
                continue;
            const groups = [];
            for (let i = 0; i < paragraphs.length; i += groupSize) {
                const slice = paragraphs.slice(i, i + groupSize);
                groups.push({
                    text: slice.join("\n\n"),
                    paragraphCount: slice.length,
                });
            }
            const messageWeight = (messageIndex + 1) / messageCount;
            groups.forEach((group, partIndex) => weighted.push({
                text: group.text,
                // Preserve the message's total weight while avoiding overweighting
                // a short final group when paragraph counts are uneven.
                weight: messageWeight * (group.paragraphCount / paragraphs.length),
                sourceMessageIndex: message.index,
                sourceRole: message.role,
                partIndex,
                partCount: groups.length,
            }));
        }
        const totalWeight = weighted.reduce((sum, query) => sum + query.weight, 0);
        if (totalWeight > 0) {
            for (const query of weighted)
                query.weight /= totalWeight;
        }
        return weighted;
    }
    /** Shared quote recognition for memory narration exclusion and dialogue extraction. */
    function dialogueQuotePatterns() {
        return [
            /"([^"\r\n]+)"/g,
            /“([^”\r\n]+)”/g,
            /「([^」\r\n]+)」/g,
            /『([^』\r\n]+)』/g,
        ];
    }
    /** Extract quoted RP dialogue without changing the message text sent to embeddings. */
    function extractDialogueLocalLines(text) {
        const lines = [];
        const seen = new Set();
        for (const pattern of dialogueQuotePatterns()) {
            pattern.lastIndex = 0;
            let match;
            while ((match = pattern.exec(text)) !== null) {
                const line = match[1]?.trim();
                if (!line || seen.has(line))
                    continue;
                seen.add(line);
                lines.push(line);
            }
        }
        return lines;
    }
    /**
     * Build retrieval inputs from recent chat messages.
     * Content queries retain dialogue across the configured recent-message window.
     * Both semantic and lexical dialogue use only the single most recent message.
     */
    async function buildRetrievalInputs(rawMessages) {
        if (currentCharIndex < 0 || currentChatIndex < 0) {
            return { embeddingQuery: "", embeddingQueries: [], querySources: [], dialogueLines: [] };
        }
        try {
            const allMessages = rawMessages ?? await readChatMessagesRaw();
            if (allMessages.length === 0) {
                return { embeddingQuery: "", embeddingQueries: [], querySources: [], dialogueLines: [] };
            }
            // Always include the last message
            const lastMsg = allMessages[allMessages.length - 1];
            const startIdx = Math.max(0, allMessages.length - embeddingContextMessages);
            const contextMsgs = allMessages.slice(startIdx, allMessages.length - 1);
            // Apply regex only to the subset we need. Preserve the untouched
            // paragraph counts so debug output can reveal how regex processing changes
            // Query Separate boundaries.
            let subset = [...contextMsgs, lastMsg];
            const originalParagraphCounts = subset.map((message) => countQueryParagraphs(message.content));
            subset = applyRegexToMessages(subset, "chatQuery");
            const parts = subset.map((m) => m.content);
            const embeddingQueries = buildWeightedEmbeddingQueries(subset.map((message) => ({
                text: message.content,
                index: message.index,
                role: message.role,
            })));
            const querySources = subset.map((message, sourceIndex) => ({
                sourceMessageIndex: message.index,
                sourceRole: message.role,
                originalParagraphCount: originalParagraphCounts[sourceIndex] ?? 0,
                processedParagraphCount: countQueryParagraphs(message.content),
                queryCount: embeddingQueries.filter((query) => query.sourceMessageIndex === message.index).length,
            }));
            return {
                embeddingQuery: parts.join("\n"),
                embeddingQueries,
                querySources,
                dialogueLines: extractDialogueLocalLines(subset[subset.length - 1].content),
            };
        }
        catch (e) {
            return { embeddingQuery: "", embeddingQueries: [], querySources: [], dialogueLines: [] };
        }
    }
    /**
     * Replace every literal occurrence without interpreting replacement tokens
     * such as "$&". This is used after ChatML parsing so roleplay-log content
     * cannot inject additional <|im_start|> blocks.
     */
    function replaceAllLiteral(source, target, replacement) {
        if (!target)
            return source;
        return source.split(target).join(replacement);
    }
    /**
     * Parse a ChatML-formatted prompt template into real multi-turn messages.
     *
     * Supported roles:
     * - system
     * - user
     * - assistant
     * - developer (mapped to system)
     * - model (mapped to assistant)
     *
     * If no ChatML markers are present, or if the ChatML is malformed, the
     * function safely falls back to the legacy single-user-message behavior.
     * The {{slot}} value is inserted only after parsing to prevent role injection
     * from the source roleplay log.
     */
    function buildPromptMessages(template, slotContent) {
        const hasChatMLMarker = template.includes("<|im_start|>") || template.includes("<|im_end|>");
        if (!hasChatMLMarker) {
            return {
                messages: [
                    {
                        role: "user",
                        content: replaceAllLiteral(template, "{{slot}}", slotContent),
                    },
                ],
                usedChatML: false,
            };
        }
        const messages = [];
        const blockPattern = /<\|im_start\|>[ \t]*([A-Za-z][A-Za-z0-9_-]*)[ \t]*\r?\n([\s\S]*?)<\|im_end\|>/g;
        let cursor = 0;
        let match;
        let malformed = false;
        while ((match = blockPattern.exec(template)) !== null) {
            // Non-whitespace text outside ChatML blocks means the template is not a
            // clean ChatML document. Fall back instead of silently dropping content.
            if (template.slice(cursor, match.index).trim().length > 0) {
                malformed = true;
                break;
            }
            const rawRole = match[1].trim().toLowerCase();
            let role;
            switch (rawRole) {
                case "system":
                    role = "system";
                    break;
                case "developer":
                    role = "system";
                    break;
                case "user":
                    role = "user";
                    break;
                case "assistant":
                    role = "assistant";
                    break;
                case "model":
                    role = "assistant";
                    break;
                default:
                    malformed = true;
                    role = "user";
                    break;
            }
            if (malformed)
                break;
            const content = replaceAllLiteral(match[2].trim(), "{{slot}}", slotContent);
            if (content.length > 0) {
                messages.push({ role, content });
            }
            cursor = blockPattern.lastIndex;
        }
        if (template.slice(cursor).trim().length > 0) {
            malformed = true;
        }
        if (malformed || messages.length === 0) {
            console.log("[Hypirk] ChatML prompt parsing failed; falling back to a single user message.");
            return {
                messages: [
                    {
                        role: "user",
                        content: replaceAllLiteral(template, "{{slot}}", slotContent),
                    },
                ],
                usedChatML: false,
            };
        }
        return { messages, usedChatML: true };
    }
    async function summarizeChunk(messages, linkedMessages) {
        if (messages.length === 0) {
            return null;
        }
        const messagesText = messages.map((m) => `<index="${m.index}">\n${m.content}\n</index>`).join("\n\n");
        const parsedPrompt = buildPromptMessages(summaryPrompt, messagesText);
        const summarizerNote = state.summarizerNote?.trim() ?? "";
        if (summarizerNote && parsedPrompt.messages.length > 0) {
            const lastPromptMessage = parsedPrompt.messages[parsedPrompt.messages.length - 1];
            lastPromptMessage.content +=
                `\n\n# Chat-local summarizer note (context only; do not summarize this note)\n${summarizerNote}`;
        }
        if (parsedPrompt.usedChatML) {
            console.log(`[Hypirk] Parsed ChatML summary prompt into ${parsedPrompt.messages.length} messages.`);
        }
        try {
            const LLM_TIMEOUT_MS = 300_000; // 5 minutes
            const result = await Promise.race([
                risuai.runLLMModel({
                    messages: parsedPrompt.messages,
                    mode: "memory",
                    allowPlugins: true,
                }),
                new Promise((_, reject) => setTimeout(() => {
                    const timeoutError = new Error("LLM call timed out after 300s");
                    timeoutError.name = "TimeoutError";
                    reject(timeoutError);
                }, LLM_TIMEOUT_MS)),
            ]);
            // risuai returns { type: "success", result: "..." }
            const rawOutput = typeof result === "string" ? result : (result?.result ?? result?.content ?? "");
            // Strip <Thoughts>...</Thoughts> block if present (some models emit thinking)
            const cleanedOutput = rawOutput.replace(/<Thoughts>[\s\S]*?<\/Thoughts>/gi, "").trim();
            const memoryWrappedOutput = ensureMemoryWrappedSummary(cleanedOutput);
            return parseSummaryEntries(memoryWrappedOutput, linkedMessages);
        }
        catch (e) {
            console.log("[Hypirk] Summarization failed:", e);
            return null;
        }
    }
    async function readEntryMessages(entry) {
        const all = await readChatMessagesRaw();
        await reconcileMessageLinks(all);
        if (isLinkProcessingBlocked())
            return [];
        const byId = new Map(all.map(message => [message.chatId, message]));
        const result = [];
        for (const slot of entry.linkedMessages) {
            const record = state.messages[String(slot)];
            if (!record)
                continue;
            if (record.chatId === FIRST_MESSAGE_CHAT_ID) {
                const first = await fetchFirstMessage();
                if (first)
                    result.push({ ...first, chatId: FIRST_MESSAGE_CHAT_ID, index: -1 });
            }
            else {
                const message = byId.get(record.chatId);
                if (message)
                    result.push({ ...message });
            }
        }
        return result.sort((a, b) => a.index - b.index);
    }
    async function rerollMemoryNode(nodeId) {
        const node = findNodeById(nodeId);
        const entry = node ? getMemoryEntry(node) : undefined;
        return entry ? summarizeMemoryEntry(entry, true) : false;
    }
    async function summarizeMemoryEntry(entry, replace = false) {
        return withChatOperation(owner => summarizeMemoryEntryInContext(owner, entry, replace));
    }
    async function summarizeMemoryEntryInContext(owner, entry, replace = false) {
        if (isSummarizing || !state.entries.includes(entry))
            return false;
        if (!await showConfirmDialog(replace ? "이 기억을 연결 원문으로 다시 요약해 교체할까요?" : "연결 원문을 요약해 새 기억을 추가할까요?"))
            return false;
        if (!isCurrentOperation(owner) || !state.entries.includes(entry) || isSummarizing)
            return false;
        const originalMemory = entry.memory;
        const originalContent = originalMemory?.content;
        isSummarizing = true;
        try {
            let batch = await readEntryMessages(entry);
            if (!batch.length) {
                alert("연결된 원문을 찾을 수 없습니다.");
                return false;
            }
            batch = applyRegexToMessages(batch);
            const summaryEntries = await summarizeChunk(batch, entry.linkedMessages);
            if (!summaryEntries?.some(result => result.memory) || !isCurrentOperation(owner) || !state.entries.includes(entry) ||
                entry.memory !== originalMemory || entry.memory?.content !== originalContent)
                return false;
            if (replace && entry.memory) {
                replaceMemoryFromSummary(entry, summaryEntries[0].memory);
                // Legacy rerolls keep their single-memory replacement behavior.
                if (summaryEntries.indexed) {
                    entry.linkedMessages = summaryEntries[0].linkedMessages;
                    for (const extra of summaryEntries.slice(1))
                        appendMemoryEntry(extra.memory, extra.linkedMessages);
                }
            }
            else {
                if (entry.memory === null) {
                    const first = summaryEntries.shift();
                    entry.memory = first.memory;
                    entry.linkedMessages = first.linkedMessages;
                }
                for (const result of summaryEntries)
                    appendMemoryEntry(result.memory, result.linkedMessages);
            }
            markEmbeddingCacheDirty();
            await saveState();
            invalidateUiSessionRenderData();
            return true;
        }
        catch (error) {
            alert(`재요약에 실패했습니다. ${String(error)}`);
            return false;
        }
        finally {
            isSummarizing = false;
        }
    }
    async function runSummarization(count, trigger = "ui-manual") {
        return withChatOperation(owner => runSummarizationInContext(owner, count, trigger));
    }
    async function runSummarizationInContext(owner, count, trigger = "ui-manual") {
        const take = count ?? chunkSize;
        if (isSummarizing) {
            return false;
        }
        if (isLinkProcessingBlocked()) {
            return false;
        }
        invalidateUiSessionRenderData();
        isSummarizing = true;
        let allMessageCount = 0;
        let startIdx = -1;
        let windowCount = 0;
        let batchCount = 0;
        let nodesCreated = 0;
        let outcome = "started";
        try {
            const allMessages = await readChatMessagesRaw();
            allMessageCount = allMessages.length;
            await reconcileMessageLinks(allMessages);
            if (isLinkProcessingBlocked()) {
                outcome = "link-safety-block";
                return false;
            }
            startIdx = getLastSummarizedMsgIndex() + 1;
            // Build the window: prepend first message (chat_index -1) if this is the first chunk
            const window = [];
            if (startIdx <= 0) {
                const firstMsg = await fetchFirstMessage();
                if (firstMsg) {
                    window.push({
                        ...firstMsg,
                        chatId: FIRST_MESSAGE_CHAT_ID,
                        index: -1,
                    });
                }
            }
            for (const message of allMessages) {
                if (message.index >= Math.max(0, startIdx) && window.length < take) {
                    window.push(message);
                }
            }
            windowCount = window.length;
            if (window.length < take) {
                // Not enough messages for a full chunk
                outcome = "insufficient-window";
                isSummarizing = false;
                return false;
            }
            let batch = includeUserMessages ? window : window.filter((m) => m.role !== "user");
            batchCount = batch.length;
            if (batch.length === 0) {
                outcome = "empty-after-role-filter";
                return false;
            }
            // Record the complete window, including skipped user messages, once per message.
            const linkedMessages = await registerMessages(window);
            batch = applyRegexToMessages(batch);
            const pendingEntry = { memory: null, linkedMessages };
            summarizationPreviewEntry = pendingEntry;
            nodeListPage = Number.MAX_SAFE_INTEGER;
            if (document.getElementById("hp-body"))
                await renderUI(true);
            // Now call LLM
            const summaryEntries = await summarizeChunk(batch, linkedMessages);
            if (summaryEntries && isCurrentOperation(owner)) {
                for (const entry of summaryEntries)
                    appendMemoryEntry(entry.memory, entry.linkedMessages);
                nodesCreated = summaryEntries.filter(entry => entry.memory).length;
                outcome = "done";
                updateLastVerifiedSummarizedIndex();
                await saveState();
                invalidateUiSessionRenderData();
            }
            else {
                // A failed UI-preview summary leaves no MemoryEntry object behind.
                outcome = "failed";
            }
            return outcome === "done";
        }
        finally {
            isSummarizing = false;
            summarizationPreviewEntry = null;
            if (document.getElementById("hp-body"))
                await renderUI(true);
        }
    }
    // ── Automatic Summarization / provider usage ───────────────────────────
    /**
     * Automatic summarization intentionally has no ON/OFF switch. It follows the
     * HypaV3-style lifecycle: measure the completed main request from provider
     * usage, remember whether it exceeded Risu's configured input budget, then
     * summarize at the beginning of the next request before Risu builds the live
     * chat window.
     */
    function autoSummaryFiniteNumber(value) {
        const n = Number(value);
        return Number.isFinite(n) && n >= 0 ? n : undefined;
    }
    function autoSummaryNormalizeText(value) {
        return String(value ?? "").replace(/\s+/g, " ").trim();
    }
    function autoSummarySafeJsonParse(text) {
        try {
            return JSON.parse(text);
        }
        catch (_) {
            return null;
        }
    }
    function autoSummaryPayloadString(value) {
        if (typeof value === "string")
            return value;
        if (value === undefined || value === null)
            return "";
        try {
            const encoded = JSON.stringify(value);
            return typeof encoded === "string" ? encoded : String(value ?? "");
        }
        catch (_) {
            return String(value ?? "");
        }
    }
    function autoSummaryHash(text) {
        let hash = 0x811c9dc5;
        for (let i = 0; i < text.length; i++) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193);
        }
        return (hash >>> 0).toString(16).padStart(8, "0");
    }
    function autoSummaryFetchLogKey(log) {
        const body = autoSummaryPayloadString(log?.body);
        const response = autoSummaryPayloadString(log?.response);
        return autoSummaryHash([
            String(log?.url ?? ""),
            String(log?.status ?? ""),
            autoSummaryHash(body),
            autoSummaryHash(response),
        ].join("|"));
    }
    function autoSummaryUsageFromObject(obj) {
        if (!obj || typeof obj !== "object")
            return undefined;
        const usage = obj.usage && typeof obj.usage === "object" ? obj.usage : obj;
        return (autoSummaryFiniteNumber(usage.input_tokens) ??
            autoSummaryFiniteNumber(usage.prompt_tokens) ??
            autoSummaryFiniteNumber(usage.inputTokens) ??
            autoSummaryFiniteNumber(usage.promptTokens) ??
            autoSummaryFiniteNumber(usage.input_token_count) ??
            autoSummaryFiniteNumber(usage.promptTokenCount));
    }
    function autoSummaryFindInputTokensDeep(value) {
        const seen = new Set();
        let best;
        const walk = (node, depth = 0) => {
            if (depth > 10 || node == null || typeof node !== "object" || seen.has(node))
                return;
            seen.add(node);
            const found = autoSummaryUsageFromObject(node);
            if (found !== undefined)
                best = best === undefined ? found : Math.max(best, found);
            if (Array.isArray(node)) {
                for (const item of node)
                    walk(item, depth + 1);
            }
            else {
                for (const child of Object.values(node))
                    walk(child, depth + 1);
            }
        };
        walk(value);
        return best;
    }
    function autoSummaryParseInputTokens(response) {
        const raw = autoSummaryPayloadString(response);
        if (!raw)
            return undefined;
        const whole = typeof response === "string" ? autoSummarySafeJsonParse(response) : response;
        if (whole && typeof whole === "object") {
            const found = autoSummaryFindInputTokensDeep(whole);
            if (found !== undefined)
                return found;
        }
        let best;
        for (const rawLine of raw.split(/\r?\n/)) {
            let line = rawLine.trim();
            if (!line)
                continue;
            if (line.startsWith("data:"))
                line = line.slice(5).trim();
            if (!line || line === "[DONE]")
                continue;
            const parsed = autoSummarySafeJsonParse(line);
            if (parsed === null)
                continue;
            const found = autoSummaryFindInputTokensDeep(parsed);
            if (found !== undefined)
                best = best === undefined ? found : Math.max(best, found);
        }
        return best;
    }
    function autoSummaryExtractProviderText(body) {
        const parsed = typeof body === "string" ? autoSummarySafeJsonParse(body) : body;
        if (!parsed || typeof parsed !== "object")
            return autoSummaryNormalizeText(body);
        const out = [];
        const pushPart = (value) => {
            if (typeof value === "string") {
                out.push(value);
                return;
            }
            if (!value || typeof value !== "object")
                return;
            if (Array.isArray(value)) {
                for (const item of value)
                    pushPart(item);
                return;
            }
            if (typeof value.input_text === "string") {
                out.push(value.input_text);
                return;
            }
            if (typeof value.text === "string") {
                out.push(value.text);
                return;
            }
            if (typeof value.content === "string") {
                out.push(value.content);
                return;
            }
            if (Array.isArray(value.parts)) {
                for (const part of value.parts)
                    pushPart(part);
                return;
            }
            if (Array.isArray(value.content)) {
                for (const part of value.content)
                    pushPart(part);
                return;
            }
        };
        if (typeof parsed.system === "string")
            out.push(parsed.system);
        if (parsed.systemInstruction)
            pushPart(parsed.systemInstruction);
        if (parsed.instructions)
            pushPart(parsed.instructions);
        if (parsed.messages)
            pushPart(parsed.messages);
        if (parsed.input)
            pushPart(parsed.input);
        if (parsed.contents)
            pushPart(parsed.contents);
        if (parsed.prompt)
            pushPart(parsed.prompt);
        return autoSummaryNormalizeText(out.join("\n"));
    }
    async function ensureAutoSummaryPermission(kind) {
        try {
            if (kind === "db") {
                if (autoSummaryDbPermission === null) {
                    autoSummaryDbPermission = typeof risuai.requestPluginPermission === "function"
                        ? await risuai.requestPluginPermission("db")
                        : typeof risuai.getDatabase === "function";
                }
                return autoSummaryDbPermission === true;
            }
            if (autoSummaryFetchLogsPermission === null) {
                autoSummaryFetchLogsPermission = typeof risuai.requestPluginPermission === "function"
                    ? await risuai.requestPluginPermission("fetchLogs")
                    : typeof risuai.getFetchLogs === "function";
            }
            return autoSummaryFetchLogsPermission === true;
        }
        catch (error) {
            console.warn(`[Hypirk] Automatic summary permission ${kind} unavailable:`, error);
            if (kind === "db")
                autoSummaryDbPermission = false;
            else
                autoSummaryFetchLogsPermission = false;
            return false;
        }
    }
    async function readAutoSummaryTokenLimits() {
        if (!await ensureAutoSummaryPermission("db") || typeof risuai.getDatabase !== "function")
            return null;
        try {
            const db = await risuai.getDatabase(["maxContext", "maxResponse"]);
            const maxContext = autoSummaryFiniteNumber(db?.maxContext);
            const maxResponse = autoSummaryFiniteNumber(db?.maxResponse) ?? 0;
            if (maxContext === undefined || maxContext <= 0)
                return null;
            const inputBudget = maxContext - maxResponse;
            if (!Number.isFinite(inputBudget) || inputBudget <= 0)
                return null;
            return { maxContext, maxResponse, inputBudget };
        }
        catch (error) {
            console.warn("[Hypirk] Failed to read maxContext/maxResponse for automatic summary:", error);
            return null;
        }
    }
    function beginAutoSummaryRequestProbe(messages, lastUserContent) {
        const normalizedLastUser = autoSummaryNormalizeText(lastUserContent);
        const recentDuplicate = [...autoSummaryRequestProbes].reverse().find((probe) => !probe.completedAt &&
            probe.charId === currentCharId &&
            probe.chatId === currentChatId &&
            probe.lastUserTail === normalizedLastUser.slice(-220) &&
            Date.now() - probe.startedAt < 5000);
        if (recentDuplicate)
            return;
        const messageTailNeedles = messages
            .map((message) => autoSummaryNormalizeText(message?.content ?? ""))
            .filter(Boolean)
            .slice(-6)
            .map((text) => text.slice(-120))
            .filter((text, index, arr) => text.length >= 4 && arr.indexOf(text) === index);
        autoSummaryRequestProbes.push({
            id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            charId: currentCharId,
            chatId: currentChatId,
            startedAt: Date.now(),
            lastUserTail: normalizedLastUser.slice(-220),
            messageTailNeedles,
        });
        autoSummaryRequestProbes = autoSummaryRequestProbes.slice(-6);
    }
    function scoreAutoSummaryProviderText(providerText, probe) {
        if (!providerText)
            return -Infinity;
        let score = 0;
        const lastUser = probe.lastUserTail;
        if (lastUser.length >= 12) {
            const longTail = lastUser.slice(-120);
            const mediumTail = lastUser.slice(-64);
            const shortTail = lastUser.slice(-32);
            if (longTail.length >= 24 && providerText.includes(longTail))
                score += 320;
            else if (mediumTail.length >= 20 && providerText.includes(mediumTail))
                score += 240;
            else if (shortTail.length >= 12 && providerText.includes(shortTail))
                score += 170;
        }
        else if (lastUser.length >= 2 && providerText.includes(lastUser)) {
            score += 60;
        }
        let auxiliaryMatches = 0;
        for (const needle of probe.messageTailNeedles) {
            if (needle === lastUser || needle.length < 12)
                continue;
            const tail = needle.slice(-80);
            if (providerText.includes(tail))
                auxiliaryMatches += 1;
        }
        score += Math.min(3, auxiliaryMatches) * 90;
        return score;
    }
    async function autoSummaryBodyInterceptor(body, type) {
        if (isSummarizing)
            return body;
        const probe = [...autoSummaryRequestProbes].reverse().find((item) => !item.completedAt &&
            item.charId === currentCharId &&
            item.chatId === currentChatId &&
            Date.now() - item.startedAt >= 0 &&
            Date.now() - item.startedAt < 15000);
        if (!probe)
            return body;
        const providerText = autoSummaryExtractProviderText(body);
        if (scoreAutoSummaryProviderText(providerText, probe) < 100)
            return body;
        if (body && typeof body === "object" && typeof body.model === "string")
            probe.bodyModel = body.model;
        probe.bodyInterceptorType = String(type ?? "");
        return body;
    }
    function scoreAutoSummaryFetchCandidate(log, probe) {
        const inputTokens = autoSummaryParseInputTokens(log?.response);
        if (inputTokens === undefined)
            return -Infinity;
        const providerText = autoSummaryExtractProviderText(log?.body);
        const textScore = scoreAutoSummaryProviderText(providerText, probe);
        if (!Number.isFinite(textScore))
            return -Infinity;
        let score = 50 + textScore; // recognizable provider input usage + context match
        const bodyParsed = typeof log?.body === "string" ? autoSummarySafeJsonParse(log.body) : log?.body;
        if (bodyParsed && typeof bodyParsed === "object") {
            if (Array.isArray(bodyParsed.input) || Array.isArray(bodyParsed.messages) || Array.isArray(bodyParsed.contents))
                score += 15;
            const bodyModel = typeof bodyParsed.model === "string" ? bodyParsed.model : "";
            if (probe.bodyModel && bodyModel) {
                if (probe.bodyModel === bodyModel)
                    score += 120;
                else
                    score -= 220;
            }
        }
        return score;
    }
    async function reconcileAutoSummaryUsage(reason, targetProbeId) {
        return withChatOperation(owner => reconcileAutoSummaryUsageInContext(owner, reason, targetProbeId));
    }
    async function reconcileAutoSummaryUsageInContext(owner, reason, targetProbeId) {
        // Follow the native-memory mode captured for this request burst.
        // Bursts that start with Risu/HypaV3 memory ON discard probes and invalidate
        // delayed reconciliation callbacks before they can reach this path.
        if (isRisuMemoryToggleEnabled())
            return false;
        if (!await ensureAutoSummaryPermission("fetchLogs") || typeof risuai.getFetchLogs !== "function")
            return false;
        const candidates = autoSummaryRequestProbes
            .filter((probe) => probe.completedAt && !probe.reconciled)
            .filter((probe) => !targetProbeId || probe.id === targetProbeId)
            .filter((probe) => probe.charId === currentCharId && probe.chatId === currentChatId)
            .sort((a, b) => a.startedAt - b.startedAt);
        if (!candidates.length)
            return false;
        let raw;
        try {
            raw = await risuai.getFetchLogs();
        }
        catch (error) {
            console.warn("[Hypirk] getFetchLogs() failed during automatic-summary reconciliation:", error);
            return false;
        }
        const logs = Array.isArray(raw) ? raw : [];
        if (!logs.length)
            return false;
        const limits = await readAutoSummaryTokenLimits();
        if (!limits)
            return false;
        let changed = false;
        for (const probe of candidates) {
            const ranked = logs
                .map((log, index) => {
                const key = autoSummaryFetchLogKey(log);
                if (autoSummaryConsumedFetchKeys.has(key) || state.autoSummaryLastFetchLogKey === key)
                    return null;
                return { log, key, index, score: scoreAutoSummaryFetchCandidate(log, probe) };
            })
                .filter((item) => item && Number.isFinite(item.score) && item.score >= 150)
                .sort((a, b) => b.score - a.score || a.index - b.index);
            const best = ranked[0];
            if (!best)
                continue;
            const inputTokens = autoSummaryParseInputTokens(best.log?.response);
            if (inputTokens === undefined)
                continue;
            const snapshot = {
                inputTokens,
                maxContext: limits.maxContext,
                maxResponse: limits.maxResponse,
                inputBudget: limits.inputBudget,
                pressureRatio: inputTokens / limits.inputBudget,
                measuredAt: Date.now(),
                fetchLogKey: best.key,
            };
            state.autoSummaryLastUsage = snapshot;
            state.autoSummaryLastFetchLogKey = best.key;
            state.autoSummaryPending = inputTokens >= limits.inputBudget;
            autoSummaryConsumedFetchKeys.add(best.key);
            probe.reconciled = true;
            changed = true;
            console.log("[Hypirk] Automatic-summary provider usage measured", {
                reason,
                inputTokens,
                maxContext: limits.maxContext,
                maxResponse: limits.maxResponse,
                inputBudget: limits.inputBudget,
                pressure: snapshot.pressureRatio,
                autoSummaryPending: state.autoSummaryPending,
                url: best.log?.url,
                score: best.score,
            });
        }
        autoSummaryRequestProbes = autoSummaryRequestProbes.filter((probe) => !probe.reconciled).slice(-6);
        if (changed)
            await saveState();
        return changed;
    }
    function scheduleAutoSummaryUsageReconciliation(probeId) {
        const generation = ++autoSummaryReconcileGeneration;
        for (const delay of [250, 800, 1800, 4000]) {
            window.setTimeout(() => {
                if (generation !== autoSummaryReconcileGeneration)
                    return;
                void reconcileAutoSummaryUsage(`afterRequest+${delay}ms`, probeId);
            }, delay);
        }
    }
    async function runPendingAutomaticSummary() {
        return withChatOperation(owner => runPendingAutomaticSummaryInContext(owner));
    }
    async function runPendingAutomaticSummaryInContext(owner) {
        // Keep pending state dormant rather than consuming it while Risu/HypaV3
        // owns memory. If the native toggle is later turned OFF, Hypirk may resume
        // from that previously pending state.
        if (isRisuMemoryToggleEnabled())
            return;
        if (!state.autoSummaryPending || isSummarizing || isLinkProcessingBlocked())
            return;
        const pending = await getPendingMessages();
        const safeChunkSize = Math.max(2, Math.floor(chunkSize || DEFAULT_CHUNK_SIZE));
        const retain = Math.max(0, Math.floor(retainedMessagesAfterSummary || 0));
        const eligibleMessages = Math.max(0, pending.length - retain);
        const fullChunkCount = Math.floor(eligibleMessages / safeChunkSize);
        // Example: pending 60, retain 10, chunk 6 -> 50 eligible -> summarize 48
        // (8 complete chunks) and leave the 2-message remainder together with the
        // protected 10-message tail.
        if (fullChunkCount <= 0) {
            state.autoSummaryPending = false;
            await saveState();
            console.log("[Hypirk] Automatic summary deferred: no complete chunk before retained tail", {
                pendingMessages: pending.length,
                retainedMessages: retain,
                chunkSize: safeChunkSize,
            });
            return;
        }
        console.log("[Hypirk] Automatic summary starting", {
            pendingMessages: pending.length,
            retainedMessages: retain,
            chunkSize: safeChunkSize,
            fullChunkCount,
            summarizeMessages: fullChunkCount * safeChunkSize,
            lastUsage: state.autoSummaryLastUsage,
        });
        let completedChunks = 0;
        for (let i = 0; i < fullChunkCount; i++) {
            const ok = await runSummarization(safeChunkSize, "auto-assistant");
            if (!ok)
                break;
            completedChunks += 1;
        }
        if (!isCurrentOperation(owner)) return;
        state.autoSummaryPending = completedChunks < fullChunkCount;
        await saveState();
        console.log("[Hypirk] Automatic summary finished", {
            requestedChunks: fullChunkCount,
            completedChunks,
            pendingRetry: state.autoSummaryPending,
        });
    }
    // ── Memory Retrieval ─────────────────────────────────────────────────────
    function parseTimeString(ts) {
        const value = String(ts ?? "").trim();
        if (!value)
            return null;
        const parseClock = (part) => {
            const match = part.match(/\b(\d{1,2}):(\d{1,2})(?:\s*([ap]\.?m\.?))?\b/i);
            if (!match)
                return null;
            let hour = Number(match[1]);
            const minute = Number(match[2]);
            const meridiem = match[3]?.replace(/\./g, "").toLowerCase();
            if (minute < 0 || minute > 59)
                return null;
            if (meridiem) {
                if (hour < 1 || hour > 12)
                    return null;
                if (meridiem === "pm" && hour !== 12)
                    hour += 12;
                if (meridiem === "am" && hour === 12)
                    hour = 0;
            }
            else if (hour < 0 || hour > 23) {
                return null;
            }
            return { hour, minute };
        };
        const makeDate = (day, clock, base) => {
            const year = day.year ?? base?.getFullYear() ?? new Date().getFullYear();
            const hour = clock?.hour ?? 0;
            const minute = clock?.minute ?? 0;
            const date = new Date(0, day.month - 1, day.day, hour, minute, 0, 0);
            date.setFullYear(year);
            if (date.getFullYear() !== year ||
                date.getMonth() !== day.month - 1 ||
                date.getDate() !== day.day ||
                date.getHours() !== hour ||
                date.getMinutes() !== minute)
                return null;
            return date;
        };
        const parsePart = (part, base) => {
            const day = parseProtoCalendarDay(part);
            const clock = parseClock(part);
            if (day)
                return makeDate(day, clock, base);
            if (base && clock) {
                const date = new Date(base);
                date.setHours(clock.hour, clock.minute, 0, 0);
                return date;
            }
            return null;
        };
        // Time is user-facing text. Extract whatever calendar/clock information is
        // available instead of requiring the whole field to match one legacy fixed format.
        const rangeParts = value.split(/\s*(?:→|->)\s*/).filter(Boolean);
        let parsed = null;
        for (const part of rangeParts) {
            const next = parsePart(part, parsed ?? undefined);
            if (next)
                parsed = next;
        }
        return parsed;
    }
    function getMemoryMessageSortIndex(memory) {
        const entry = getMemoryEntry(memory);
        if (!entry)
            return null;
        const indices = getEntryMessageIndices(entry);
        return indices.length ? indices[0] : null;
    }
    function compareNodesByTime(a, b) {
        const aTime = memorySortTime(a);
        const bTime = memorySortTime(b);
        if (aTime && bTime) {
            const timeDiff = aTime.getTime() - bTime.getTime();
            if (timeDiff)
                return timeDiff;
        }
        // If time is unavailable or resolves to the same point/day, prefer the
        // memory's position in the source chat. createdAt is only the last fallback.
        const aIndex = getMemoryMessageSortIndex(a);
        const bIndex = getMemoryMessageSortIndex(b);
        if (aIndex !== null && bIndex !== null && aIndex !== bIndex)
            return aIndex - bIndex;
        return (a.createdAt - b.createdAt ||
            a.id.localeCompare(b.id, undefined, {
                numeric: true,
            }));
    }
    function getLikeRemaining(node, now = Date.now()) {
        if (!Number.isFinite(node.likedAt))
            return 0;
        const elapsed = Math.max(0, now - Number(node.likedAt));
        return Math.max(0, Math.min(1, 1 - elapsed / LIKE_DECAY_MS));
    }
    function getLikeBonus(node, now = Date.now()) {
        return likeBonusBase * getLikeRemaining(node, now);
    }
    function normalizeDialogueLocalText(text) {
        return String(text ?? "")
            .normalize("NFKC")
            .toLocaleLowerCase()
            .replace(/[‘’']/g, "")
            .replace(/[\p{P}\p{S}]+/gu, " ")
            .replace(/\s+/g, " ")
            .trim();
    }
    function dialogueTrigrams(normalized) {
        const words = normalized.split(" ").filter(Boolean);
        const trigrams = [];
        for (let i = 0; i <= words.length - 3; i++) {
            trigrams.push(words.slice(i, i + 3).join(" "));
        }
        return [...new Set(trigrams)];
    }
    function compareDialogueLocalPair(currentDialogue, storedDialogue) {
        const current = normalizeDialogueLocalText(currentDialogue);
        const stored = normalizeDialogueLocalText(storedDialogue);
        if (!current || !stored)
            return null;
        if (current === stored)
            return { score: 1, method: "exact" };
        // Substring matching is token-sequence based, not raw character inclusion.
        // Require at least two complete tokens in the shorter dialogue so tiny replies
        // such as "No" / "None" cannot spuriously match "Not..." or a single word
        // buried inside a long remembered line. One-token dialogues still match via exact.
        const currentTokens = current.split(" ").filter(Boolean);
        const storedTokens = stored.split(" ").filter(Boolean);
        const shorterTokens = currentTokens.length <= storedTokens.length ? currentTokens : storedTokens;
        const longerTokens = currentTokens.length <= storedTokens.length ? storedTokens : currentTokens;
        if (shorterTokens.length >= 2) {
            let contiguousTokenMatch = false;
            for (let start = 0; start <= longerTokens.length - shorterTokens.length; start++) {
                let matched = true;
                for (let offset = 0; offset < shorterTokens.length; offset++) {
                    if (longerTokens[start + offset] !== shorterTokens[offset]) {
                        matched = false;
                        break;
                    }
                }
                if (matched) {
                    contiguousTokenMatch = true;
                    break;
                }
            }
            if (contiguousTokenMatch) {
                const lengthRatio = shorterTokens.length / longerTokens.length;
                return { score: 0.9 + 0.08 * lengthRatio, method: "substring" };
            }
        }
        const currentNgrams = dialogueTrigrams(current);
        const storedNgrams = dialogueTrigrams(stored);
        if (currentNgrams.length === 0 || storedNgrams.length === 0)
            return null;
        const storedSet = new Set(storedNgrams);
        const sharedNgrams = currentNgrams.filter((ngram) => storedSet.has(ngram));
        if (sharedNgrams.length === 0)
            return null;
        return {
            score: (2 * sharedNgrams.length) / (currentNgrams.length + storedNgrams.length),
            method: "3-word Dice",
            sharedNgrams,
        };
    }
    function normalizeActivationText(text) {
        return String(text ?? "")
            .normalize("NFKC")
            .toLocaleLowerCase()
            .replace(/[\p{P}\p{S}]+/gu, " ")
            .replace(/\s+/g, " ")
            .trim();
    }
    function activationCuePairScore(cueText, queryText) {
        const cue = normalizeActivationText(cueText);
        const query = normalizeActivationText(queryText);
        if (!cue || !query)
            return null;
        const cueTokens = cue.split(" ").filter(Boolean);
        const queryTokens = query.split(" ").filter(Boolean);
        if (cueTokens.length === 0 || queryTokens.length === 0)
            return null;
        const phrase = query === cue || query.includes(cue);
        if (phrase)
            return { score: 1, method: "phrase" };
        const cueSet = new Set(cueTokens);
        const querySet = new Set(queryTokens);
        let shared = 0;
        for (const token of cueSet)
            if (querySet.has(token))
                shared++;
        if (shared === 0)
            return null;
        const score = shared / cueSet.size;
        return score >= 0.5 ? { score, method: "token coverage" } : null;
    }
    function getActivationCueMatch(node, queryTexts) {
        if (!node.activationCues?.length || queryTexts.length === 0)
            return null;
        let best = null;
        for (const cue of node.activationCues) {
            for (const queryText of queryTexts) {
                const match = activationCuePairScore(cue, queryText);
                if (!match || (best && match.score <= best.score))
                    continue;
                best = { score: match.score, provenance: { cue, queryText, method: match.method, score: match.score } };
            }
        }
        return best;
    }
    function getDialogueLocalMatch(node, currentDialogues) {
        const storedDialogues = extractStructuredContentDialogues(node.content);
        if (currentDialogues.length === 0 || storedDialogues.length === 0)
            return null;
        let best = null;
        for (const currentDialogue of currentDialogues) {
            for (const stored of storedDialogues) {
                const match = compareDialogueLocalPair(currentDialogue, stored.text);
                if (!match || (best && match.score <= best.score))
                    continue;
                best = {
                    score: match.score,
                    provenance: {
                        currentDialogue,
                        storedDialogue: stored.text,
                        storedSpeaker: stored.speaker,
                        method: match.method,
                        sharedNgrams: match.sharedNgrams,
                    },
                };
            }
        }
        return best;
    }
    async function retrieveRelevantNodes(query, tokenBudget, currentDialogues = [], excludedNodeIds = new Set(), expandedQueries = [], querySources = [], retrievalAt = Date.now(), retrievalTimelineDetection = null, requestQueryCount = 0, budgetItems = null) {
        lastEmbeddingRetrievalTrace = null;
        const allNodes = getNodes();
        if (allNodes.length === 0) {
            return { nodes: [], scores: {}, chosenIds: [], recentIds: [...excludedNodeIds], ledgerRows: [] };
        }
        // Recent memory is calculated before similarity retrieval for every placeholder
        // combination. The selected recent IDs are excluded from the similarity pool.
        const excludedIds = new Set(excludedNodeIds);
        // Separate favorites — they always get included regardless of score
        const favorites = allNodes.filter((n) => n.favorite && !excludedIds.has(n.id));
        const nonFavorites = allNodes.filter((n) => !n.favorite && !excludedIds.has(n.id));
        // Compute similarity scores with batched embeddings if configured
        const similarityScores = new Map();
        const dialogueEmbeddingScores = new Map();
        const dialogueEmbeddingMatches = new Map();
        const dialogueEmbeddingStatusByNode = new Map();
        const dialogueEmbeddingChildCountByNode = new Map();
        let dialogueEmbeddingQueryCount = 0;
        let effectiveEmbeddingQueryCount = 0;
        const embeddingStatusByNode = new Map();
        let currentDialogueBundle = buildCurrentDialogueEmbeddingBundle(currentDialogues);
        let currentDialogueBundleEmbedding = null;
        if (!embeddingUrl) {
            for (const node of nonFavorites)
                embeddingStatusByNode.set(node.id, "not-configured");
        }
        if (embeddingUrl && nonFavorites.length > 0) {
            const requestedQueries = expandedQueries.length > 0
                ? expandedQueries
                : [{ text: query, weight: 1, partIndex: 0, partCount: 1 }];
            currentDialogueBundle = buildCurrentDialogueEmbeddingBundle(currentDialogues);
            // Query fragments and the current dialogue bundle share one embedding HTTP batch.
            const queryBatchTexts = [
                ...requestedQueries.map((item) => item.text),
                ...(currentDialogueBundle ? [currentDialogueBundle] : []),
            ];
            const queryBatchEmbeddings = await getBatchEmbeddings(queryBatchTexts);
            const queryEmbResult = queryBatchEmbeddings.slice(0, requestedQueries.length);
            currentDialogueBundleEmbedding = currentDialogueBundle
                ? queryBatchEmbeddings[requestedQueries.length]
                : null;
            const firstQueryEmbedding = queryEmbResult.find((embedding) => isFiniteEmbeddingVector(embedding));
            if (isFiniteEmbeddingVector(firstQueryEmbedding)) {
                const validQueries = requestedQueries
                    .map((item, index) => ({ ...item, embedding: queryEmbResult[index] }))
                    .filter((item) => isFiniteEmbeddingVector(item.embedding, firstQueryEmbedding.length));
                const validWeightTotal = validQueries.reduce((sum, item) => sum + item.weight, 0) || 1;
                for (const item of validQueries)
                    item.weight /= validWeightTotal;
                effectiveEmbeddingQueryCount = validQueries.length;
                const traceSources = querySources.length > 0
                    ? querySources.map((source) => ({ ...source }))
                    : [{
                            sourceMessageIndex: undefined,
                            sourceRole: undefined,
                            originalParagraphCount: countQueryParagraphs(query),
                            processedParagraphCount: countQueryParagraphs(query),
                            queryCount: validQueries.length,
                        }];
                lastEmbeddingRetrievalTrace = {
                    createdAt: Date.now(),
                    mode: "query-separated",
                    paragraphGroupSize: Math.max(1, Math.floor(queryParagraphGroupSize)),
                    sources: traceSources,
                    queries: validQueries.map((item) => ({
                        text: item.text,
                        weight: item.weight,
                        sourceMessageIndex: item.sourceMessageIndex,
                        sourceRole: item.sourceRole,
                        partIndex: item.partIndex,
                        partCount: item.partCount,
                    })),
                    nodes: {},
                };
                const configHash = await getNodeEmbeddingConfigHash();
                const candidates = await Promise.all(nonFavorites.map(async (node) => {
                    const memoryText = buildNodeEmbeddingText(node);
                    return {
                        node,
                        memoryText,
                        sourceHash: await hashMessageContent(memoryText),
                    };
                }));
                const statuses = await ensureCandidateEmbeddings(candidates, {
                    configHash, dimensions: firstQueryEmbedding.length,
                    readCache: ({ node }) => ({ embedding: node.embedding,
                        sourceHash: node.embeddingSourceHash, configHash: node.embeddingConfigHash }),
                    writeCache: ({ node }, cache) => {
                        node.embedding = cache.embedding;
                        node.embeddingSourceHash = cache.sourceHash;
                        node.embeddingConfigHash = cache.configHash;
                        delete node.embeddingChildren;
                        delete node.embeddingConfig;
                        markEmbeddingCacheDirty();
                    },
                });
                for (const candidate of candidates)
                    embeddingStatusByNode.set(candidate.node.id, statuses.get(candidate));
                const rankedNodes = [];
                for (const candidate of candidates) {
                    if (embeddingStatusByNode.get(candidate.node.id) !== "ok")
                        continue;
                    const vector = candidate.node.embedding;
                    if (!isFiniteEmbeddingVector(vector, firstQueryEmbedding.length))
                        continue;
                    const querySimilarities = validQueries.map((item) => cosineSimilarity(item.embedding, vector));
                    const score = querySimilarities.reduce((sum, similarity, queryIndex) => sum + validQueries[queryIndex].weight * similarity, 0);
                    rankedNodes.push({
                        nodeId: candidate.node.id,
                        score,
                        querySimilarities,
                        memoryText: candidate.memoryText,
                    });
                }
                rankedNodes.sort((a, b) => b.score - a.score);
                rankedNodes.forEach((row, index) => {
                    const globalRank = index + 1;
                    similarityScores.set(row.nodeId, row.score);
                    if (lastEmbeddingRetrievalTrace) {
                        lastEmbeddingRetrievalTrace.nodes[row.nodeId] = {
                            nodeId: row.nodeId,
                            memoryText: row.memoryText,
                            querySimilarities: [...row.querySimilarities],
                            embeddingScore: row.score,
                            globalRank,
                        };
                    }
                });
            }
            else {
                for (const node of nonFavorites)
                    embeddingStatusByNode.set(node.id, "query-failed");
            }
            for (const node of nonFavorites) {
                if (!embeddingStatusByNode.has(node.id))
                    embeddingStatusByNode.set(node.id, "node-failed");
            }
        }
        // Semantic dialogue lane: one current dialogue bundle vs one cached dialogue bundle per Memory.
        if (!embeddingUrl) {
            for (const node of nonFavorites)
                dialogueEmbeddingStatusByNode.set(node.id, "not-configured");
        }
        else if (currentDialogueBundle && nonFavorites.length > 0) {
            const dialogueReferenceEmbedding = isFiniteEmbeddingVector(currentDialogueBundleEmbedding)
                ? currentDialogueBundleEmbedding
                : null;
            if (dialogueReferenceEmbedding) {
                dialogueEmbeddingQueryCount = 1;
                const dialogueConfigHash = await getDialogueEmbeddingConfigHash();
                const candidates = await Promise.all(nonFavorites.map(async (node) => {
                    const text = buildNodeDialogueEmbeddingBundle(node);
                    return {
                        node,
                        text,
                        sourceHash: await hashMessageContent(text),
                    };
                }));
                const statuses = await ensureCandidateEmbeddings(candidates, {
                    configHash: dialogueConfigHash, dimensions: dialogueReferenceEmbedding.length,
                    readCache: ({ node }) => node.dialogueEmbeddingChildren?.length === 1 &&
                        node.dialogueEmbeddingChildren[0].sourceHash === node.dialogueEmbeddingSourceHash
                        ? { embedding: node.dialogueEmbeddingChildren[0].embedding,
                            sourceHash: node.dialogueEmbeddingSourceHash, configHash: node.dialogueEmbeddingConfigHash }
                        : null,
                    writeCache: ({ node }, cache) => {
                        // Preserve the existing cache schema; one bundle occupies this slot.
                        node.dialogueEmbeddingChildren = [{ sourceHash: cache.sourceHash, embedding: cache.embedding }];
                        node.dialogueEmbeddingSourceHash = cache.sourceHash;
                        node.dialogueEmbeddingConfigHash = cache.configHash;
                        markEmbeddingCacheDirty();
                    },
                });
                for (const candidate of candidates) {
                    dialogueEmbeddingChildCountByNode.set(candidate.node.id, candidate.text ? 1 : 0);
                    dialogueEmbeddingStatusByNode.set(candidate.node.id, statuses.get(candidate));
                }
                for (const candidate of candidates) {
                    if (dialogueEmbeddingStatusByNode.get(candidate.node.id) !== "ok")
                        continue;
                    const vector = candidate.node.dialogueEmbeddingChildren?.[0]?.embedding;
                    if (!isFiniteEmbeddingVector(vector, dialogueReferenceEmbedding.length)) {
                        dialogueEmbeddingStatusByNode.set(candidate.node.id, "node-failed");
                        continue;
                    }
                    const score = cosineSimilarity(dialogueReferenceEmbedding, vector);
                    dialogueEmbeddingScores.set(candidate.node.id, score);
                    dialogueEmbeddingMatches.set(candidate.node.id, {
                        currentDialogue: currentDialogueBundle,
                        storedDialogue: candidate.text,
                        score,
                    });
                }
            }
            else {
                for (const node of nonFavorites)
                    dialogueEmbeddingStatusByNode.set(node.id, "query-failed");
            }
        }
        else {
            for (const node of nonFavorites)
                dialogueEmbeddingStatusByNode.set(node.id, currentDialogueBundle ? "not-configured" : "empty-node");
        }
        // Score each non-favorite node. 좋아요 is a separate, wall-clock-decaying preference signal.
        const scoreNow = Date.now();
        const scored = [];
        for (const node of nonFavorites) {
            const similarityScore = similarityScores.get(node.id) ?? 0;
            const dialogueMatch = getDialogueLocalMatch(node, currentDialogues);
            const dialogueLocal = dialogueMatch?.score ?? 0;
            const dialogueContribution = dialogueLocal * dialogueLocalWeight;
            const dialogueEmbedding = dialogueEmbeddingScores.get(node.id) ?? 0;
            const dialogueEmbeddingContribution = dialogueEmbeddingStatusByNode.get(node.id) === "ok"
                ? Math.max(0, dialogueEmbedding) * dialogueEmbeddingWeight
                : 0;
            const activationMatch = getActivationCueMatch(node, expandedQueries.length > 0 ? expandedQueries.map((item) => item.text) : [query]);
            const activationCue = activationMatch?.score ?? 0;
            const activationCueContribution = activationCue * activationCueWeight;
            const likeBonus = getLikeBonus(node, scoreNow);
            scored.push({
                node,
                similarity: similarityScore,
                dialogueLocal,
                dialogueContribution,
                dialogueMatch: dialogueMatch?.provenance,
                dialogueEmbedding,
                dialogueEmbeddingContribution,
                dialogueEmbeddingStatus: dialogueEmbeddingStatusByNode.get(node.id) ?? (embeddingUrl ? "empty-node" : "not-configured"),
                dialogueEmbeddingMatch: dialogueEmbeddingMatches.get(node.id),
                activationCue,
                activationCueContribution,
                activationCueMatch: activationMatch?.provenance,
                embeddingStatus: embeddingStatusByNode.get(node.id) ?? (embeddingUrl ? "node-failed" : "not-configured"),
                likeBonus,
                combined: similarityScore + dialogueContribution + dialogueEmbeddingContribution + activationCueContribution + likeBonus,
            });
        }
        // Store scores for display
        const nodeScores = new Map();
        const chosenNodeIds = new Set();
        for (const s of scored) {
            nodeScores.set(s.node.id, {
                similarity: s.similarity,
                dialogueLocal: s.dialogueLocal,
                dialogueContribution: s.dialogueContribution,
                dialogueMatch: s.dialogueMatch,
                dialogueEmbedding: s.dialogueEmbedding,
                dialogueEmbeddingContribution: s.dialogueEmbeddingContribution,
                dialogueEmbeddingStatus: s.dialogueEmbeddingStatus,
                dialogueEmbeddingQueryCount,
                dialogueEmbeddingChildCount: dialogueEmbeddingChildCountByNode.get(s.node.id) ?? 0,
                dialogueEmbeddingMatch: s.dialogueEmbeddingMatch,
                activationCue: s.activationCue,
                activationCueContribution: s.activationCueContribution,
                activationCueMatch: s.activationCueMatch,
                embeddingStatus: s.embeddingStatus,
                embeddingMode: "query-separated",
                embeddingQueryCount: effectiveEmbeddingQueryCount,
                likeBonus: s.likeBonus,
                combined: s.combined,
            });
        }
        // Favorites get max score for display
        for (const f of favorites) {
            nodeScores.set(f.id, { similarity: 1.0, likeBonus: 0, combined: 1.0 });
        }
        // Sort non-favorites by score descending
        scored.sort((a, b) => b.combined - a.combined);
        // Choose nodes within the similarity-memory budget — favorites first.
        // Main-model memory budgeting uses o200k_base and includes the configured
        // separator exactly as the final chosen context will render it.
        budgetItems ??= await prepareMemoryBudgetItems(allNodes);
        const budgetById = new Map(budgetItems.map(item => [item.node.id, item]));
        const rankedCandidates = [...sortNodesByTime(favorites), ...scored.filter(item => item.combined >= 0.05).map(item => item.node)];
        const selection = selectWithinTokenBudget(rankedCandidates.map(node => budgetById.get(node.id)).filter(Boolean),
            tokenBudget, countMemoryTokensSync(resolveInjectionText(memorySeparator)), "skip");
        const chosen = selection.items.map(item => item.node);
        // Track which nodes were chosen for similarity memory.
        for (const n of chosen) {
            chosenNodeIds.add(n.id);
        }
        // Compact Similar ledger. Recent memories were excluded before similarity scoring,
        // so the source marker is always exactly one of R or S (never both).
        const rankedForHistory = scored.map((item, index) => ({ item, rank: index + 1 }));
        const historyRows = rankedForHistory.filter(({ item, rank }) => rank <= RETRIEVAL_HISTORY_TOP_N || chosenNodeIds.has(item.node.id));
        const similarLedgerRows = historyRows.map(({ item, rank }) => buildCompactRetrievalLedgerRow({
            at: retrievalAt, node: item.node, source: "S", rank, selected: chosenNodeIds.has(item.node.id),
            queryCount: effectiveEmbeddingQueryCount || requestQueryCount, timelineDetection: retrievalTimelineDetection,
            scores: {
                content: item.similarity, dialogueSemantic: item.dialogueEmbedding,
                dialogueSemanticContribution: item.dialogueEmbeddingContribution, dialogueLexical: item.dialogueLocal,
                dialogueLexicalContribution: item.dialogueContribution, activation: item.activationCue,
                activationContribution: item.activationCueContribution, likeBonus: item.likeBonus, total: item.combined,
            },
        }));
        // Sort chosen memory by time for chronological context.
        chosen.splice(0, chosen.length, ...sortNodesByTime(chosen));
        return { nodes: chosen, scores: Object.fromEntries(nodeScores),
            chosenIds: [...chosenNodeIds], recentIds: [...excludedIds], ledgerRows: similarLedgerRows };
    }
    function applyRetrievalResult(result) {
        state.lastNodeScores = result.scores;
        state.lastChosenNodeIds = result.chosenIds;
        state.lastRecentNodeIds = result.recentIds;
        markDerivedCacheDirty();
    }
    const CONTEXT_TEMPLATE_FIELDS = [
        "time",
        "content",
    ];
    function replaceContextTemplatePlaceholders(template, values) {
        let rendered = template;
        for (const field of CONTEXT_TEMPLATE_FIELDS) {
            const value = values[field];
            if (value.trim().length === 0) {
                const standalonePlaceholderPattern = new RegExp(`^[ \t]*\\[\\[${field}\\]\\][ \t]*(?:\\r?\\n|$)`, "gm");
                rendered = rendered.replace(standalonePlaceholderPattern, "");
            }
            rendered = rendered.split(`[[${field}]]`).join(value);
        }
        return rendered;
    }
    function formatNodeForContext(node) {
        // Dialogue text, when present, now lives directly inside content.
        const template = eventFormat;
        const values = {
            time: node.time,
            content: node.content,
        };
        let rendered = replaceContextTemplatePlaceholders(template, values);
        return (rendered
            // Clean up: collapse " |  | " → " | "
            .replace(/\s*\|\s+\|\s*/g, " | ")
            // Clean up: remove " | " at start of line (after leading text like "[기억: ")
            .replace(/^(\[.*?)\s*\|\s*\]/gm, "$1]")
            // Clean up: remove trailing " | " before newline
            .replace(/\s*\|\s*\n/g, "\n")
            // Clean up: remove empty lines that only have separators
            .replace(/^[ |\t]+$/gm, "")
            // Clean up: collapse 3+ newlines to 2
            .replace(/\n{3,}/g, "\n\n")
            .trim());
    }
    function splitMemoryBudget(totalTokens, recentRatio) {
        const total = Math.max(0, Math.floor(totalTokens));
        const ratio = Math.min(1, Math.max(0, recentRatio));
        const recentBudget = Math.floor(total * ratio);
        return { totalTokens: total, recentRatio: ratio, recentBudget, chosenBudget: total - recentBudget };
    }
    // Recent stops at the first overflow; ranked candidates skip oversized items.
    function selectWithinTokenBudget(items, budget, separatorTokens, overflow = "skip") {
        const selected = [];
        let usedTokens = 0;
        for (const item of items) {
            const added = item.tokens + (selected.length ? separatorTokens : 0);
            if (usedTokens + added > budget) {
                if (overflow === "stop") break;
                continue;
            }
            selected.push(item); usedTokens += added;
        }
        return { items: selected, usedTokens };
    }
    function memoryBudgetItemsSync(nodes) {
        return nodes.map(node => {
            const text = formatNodeForContext(node);
            return { node, text, tokens: countMemoryTokensSync(text) };
        });
    }
    async function prepareMemoryBudgetItems(nodes = getNodes()) {
        await ensureO200kMemoryTokenizer();
        return memoryBudgetItemsSync(nodes);
    }
    function estimateMemoryBudget(totalTokens, recentRatio) {
        const budget = splitMemoryBudget(totalTokens, recentRatio);
        const items = memoryBudgetItemsSync(sortNodesByTime(getNodes(), "desc"));
        const recent = selectWithinTokenBudget(items, budget.recentBudget,
            countMemoryTokensSync(resolveInjectionText(memorySeparator)), "stop");
        return { ...budget, recentNodeCount: recent.items.length, recentEstimatedTokens: recent.usedTokens };
    }
    /**
     * Select a contiguous newest-first run that fits the current recent-memory
     * token share. The count is intentionally recalculated for every request so
     * editing a card immediately changes how many recent cards fit.
     */
    async function selectRecentNodesWithinBudget(tokenBudget, budgetItems = null) {
        if (tokenBudget <= 0) return { nodes: [], estimatedTokens: 0 };
        budgetItems ??= await prepareMemoryBudgetItems();
        const byId = new Map(budgetItems.map(item => [item.node.id, item]));
        const newestFirst = sortNodesByTime(budgetItems.map(item => item.node), "desc");
        const selection = selectWithinTokenBudget(newestFirst.map(node => byId.get(node.id)), tokenBudget,
            countMemoryTokensSync(resolveInjectionText(memorySeparator)), "stop");
        return { nodes: sortNodesByTime(selection.items.map(item => item.node)), estimatedTokens: selection.usedTokens };
    }
    async function buildMemoryContexts(userInput, hasChosenPlaceholder, retrievalInputs = null) {
        return withChatOperation(owner => buildMemoryContextsInContext(owner, userInput, hasChosenPlaceholder, retrievalInputs));
    }
    async function buildMemoryContextsInContext(owner, userInput, hasChosenPlaceholder, retrievalInputs = null) {
        retrievalInputs ??= await buildRetrievalInputs();
        const retrievalAt = Date.now();
        const retrievalTimelineDetection = detectCurrentTimelineDate();
        const requestQueryCount = Math.max(1, retrievalInputs.embeddingQueries.length || 1);
        const query = retrievalInputs.embeddingQuery || userInput;
        const currentDialogues = retrievalInputs.dialogueLines;
        const { recentBudget, chosenBudget } = splitMemoryBudget(maxMemoryTokens, recentMemoryRatio);
        const budgetItems = await prepareMemoryBudgetItems();
        const renderedById = new Map(budgetItems.map(item => [item.node.id, item.text]));
        // Recent selection is always calculated first, even when only {{chosen}} is
        // present. Recent memories are an exclusion range for similarity retrieval;
        // whether they are rendered is decided separately by the placeholders.
        const recentSelection = await selectRecentNodesWithinBudget(recentBudget, budgetItems);
        const recentIds = new Set(recentSelection.nodes.map((node) => node.id));
        // When {{hypa}} alone renders Recent + Similar as one joined block, the
        // separator between those two shares is part of the same total budget.
        // Charge that one bridge separator to the Similar share. With a separate
        // {{chosen}} placeholder there is no such joined-block separator here.
        const resolvedMemorySeparatorForBudget = resolveInjectionText(memorySeparator);
        const bridgeSeparatorTokens = !hasChosenPlaceholder && recentSelection.nodes.length > 0 && chosenBudget > 0 && resolvedMemorySeparatorForBudget
            ? await countMemoryTokens(resolvedMemorySeparatorForBudget)
            : 0;
        const chosenSelectionBudget = Math.max(0, chosenBudget - bridgeSeparatorTokens);
        const retrieval = chosenSelectionBudget > 0
            ? await retrieveRelevantNodes(query, chosenSelectionBudget, currentDialogues, recentIds, retrievalInputs.embeddingQueries.length > 0
                ? retrievalInputs.embeddingQueries
                : [{ text: query, weight: 1, partIndex: 0, partCount: 1 }], retrievalInputs.querySources, retrievalAt, retrievalTimelineDetection, requestQueryCount, budgetItems)
            : { nodes: [], scores: {}, chosenIds: [], recentIds: [...recentIds], ledgerRows: [] };
        if (!isCurrentOperation(owner)) return { hypaContext: "", chosenContext: "" };
        const chosenNodes = retrieval.nodes;
        applyRetrievalResult(retrieval);
        const recentLedgerRows = recentSelection.nodes.map((node) => buildCompactRetrievalLedgerRow({
            at: retrievalAt, node, source: "R", rank: null, selected: true, queryCount: requestQueryCount,
            timelineDetection: retrievalTimelineDetection,
        }));
        await appendCompactRetrievalLedgerRows([...retrieval.ledgerRows, ...recentLedgerRows]);
        await saveState();
        const hypaNodes = hasChosenPlaceholder
            ? recentSelection.nodes
            : sortNodesByTime([...recentSelection.nodes, ...chosenNodes]);
        const resolvedMemorySeparator = resolveInjectionText(memorySeparator);
        const hypaContext = hypaNodes.map(node => renderedById.get(node.id) ?? "").join(resolvedMemorySeparator);
        const chosenContext = hasChosenPlaceholder
            ? chosenNodes.map(node => renderedById.get(node.id) ?? "").join(resolvedMemorySeparator)
            : "";
        return {
            hypaContext,
            chosenContext,
            recentNodeCount: recentSelection.nodes.length,
            recentEstimatedTokens: recentSelection.estimatedTokens,
            recentBudget,
            chosenBudget,
        };
    }
    function makeLorebookPositionPlaceholderRegex() {
        return new RegExp(LOREBOOK_POSITION_PLACEHOLDER_PATTERN.source, "g");
    }
    function collectLorebookPositionTargets(messages) {
        const targets = new Set();
        for (const message of messages) {
            const regex = makeLorebookPositionPlaceholderRegex();
            for (const match of message.content.matchAll(regex)) {
                const target = match[1]?.trim();
                if (target)
                    targets.add(target);
            }
        }
        return targets;
    }
    function extractLorebookPositions(content) {
        const positions = new Set();
        const regex = new RegExp(LOREBOOK_POSITION_DECORATOR_PATTERN.source, "gm");
        for (const match of content.matchAll(regex)) {
            const position = match[1]?.trim();
            if (position)
                positions.add(position);
        }
        return [...positions];
    }
    function stripLorebookDecoratorLines(content) {
        // Remove the whole decorator line including its line break. This makes an
        // initial decorator disappear without leaving a blank line in either the
        // embedding surface or the final injected body.
        return String(content ?? "")
            .replace(/\r\n?/g, "\n")
            .replace(new RegExp(LOREBOOK_DECORATOR_LINE_PATTERN.source, "gm"), "")
            .trim();
    }
    async function readCurrentLorebookEntriesForRetrieval() {
        if (currentCharIndex < 0 || currentChatIndex < 0)
            return [];
        const [characterRaw, chatRaw] = await Promise.all([
            risuai.getCharacterFromIndex(currentCharIndex),
            risuai.getChatFromIndex(currentCharIndex, currentChatIndex),
        ]);
        if (!characterRaw || !chatRaw)
            return [];
        const character = characterRaw;
        const chat = chatRaw;
        return [
            ...readLorebookPageEntries(character.globalLore, "character", "캐릭터"),
            ...readLorebookPageEntries(chat.localLore, "chat", "채팅"),
        ];
    }
    async function getLorebookEmbeddingConfigHash() {
        return hashMessageContent([
            `lorebook-embedding-schema:${LOREBOOK_EMBEDDING_SCHEMA_VERSION}`,
            "lorebook-embedding-text-mode:whole-content-without-decorators-v1",
            embeddingUrl,
            embeddingModel,
        ].join("\u0000"));
    }
    async function loadLorebookEmbeddingCache() {
        const storage = await getDeviceLocalEmbeddingStorage();
        if (!storage || !currentCharId || !currentChatId)
            return null;
        try {
            const saved = await storage.getItem(getLocalLorebookEmbeddingCacheKey(currentCharId, currentChatId));
            if (saved?.format !== "hypirk-local-lorebook-embedding-cache" ||
                saved?.schemaVersion !== 1 ||
                saved?.charId !== currentCharId ||
                saved?.chatId !== currentChatId ||
                !saved?.entries || typeof saved.entries !== "object")
                return null;
            return saved;
        }
        catch (error) {
            console.log("[Hypirk] Failed to load lorebook embedding cache:", error);
            return null;
        }
    }
    async function saveLorebookEmbeddingCache(entries) {
        const storage = await getDeviceLocalEmbeddingStorage();
        if (!storage || !currentCharId || !currentChatId)
            return;
        const key = getLocalLorebookEmbeddingCacheKey(currentCharId, currentChatId);
        try {
            if (Object.keys(entries).length === 0) {
                await storage.removeItem(key);
                return;
            }
            const record = {
                format: "hypirk-local-lorebook-embedding-cache",
                schemaVersion: 1,
                charId: currentCharId,
                chatId: currentChatId,
                entries,
                updatedAt: Date.now(),
            };
            await storage.setItem(key, record);
        }
        catch (error) {
            console.log("[Hypirk] Failed to save lorebook embedding cache:", error);
        }
    }
    async function buildPositionLorebookContexts(targets, fallbackQuery, retrievalInputs = null) {
        return withChatOperation(owner => buildPositionLorebookContextsInContext(owner, targets, fallbackQuery, retrievalInputs));
    }
    async function buildPositionLorebookContextsInContext(owner, targets, fallbackQuery, retrievalInputs = null) {
        const contexts = new Map();
        for (const target of targets)
            contexts.set(target, "");
        if (targets.size === 0 || !embeddingUrl || maxLorebookTokens <= 0)
            return contexts;
        const lores = await readCurrentLorebookEntriesForRetrieval();
        const candidates = [];
        for (const lore of lores) {
            const positions = extractLorebookPositions(lore.content);
            if (!positions.some(position => targets.has(position)))
                continue;
            const content = stripLorebookDecoratorLines(lore.content);
            if (!content)
                continue;
            candidates.push({
                lore,
                content,
                text: content,
                positions,
                sourceHash: await hashMessageContent(content),
            });
        }
        if (candidates.length === 0)
            return contexts;
        // Lorebook comparison intentionally uses one whole recent-message query.
        // It does not split dialogue or paragraphs into separate semantic lanes.
        retrievalInputs ??= await buildRetrievalInputs();
        const query = normalizeEmbeddingWhitespace(retrievalInputs.embeddingQuery || fallbackQuery);
        if (!query)
            return contexts;
        const [queryEmbedding] = await getBatchEmbeddings([query]);
        if (!isFiniteEmbeddingVector(queryEmbedding))
            return contexts;
        const configHash = await getLorebookEmbeddingConfigHash();
        const cached = await loadLorebookEmbeddingCache();
        const liveIds = new Set(lores.map(lore => lore.uid));
        const nextCache = Object.fromEntries(Object.entries(cached?.entries ?? {}).filter(([id]) => liveIds.has(id)));
        let cacheChanged = Object.keys(nextCache).length !== Object.keys(cached?.entries ?? {}).length;
        await ensureCandidateEmbeddings(candidates, {
            configHash, dimensions: queryEmbedding.length,
            readCache: candidate => cached?.entries?.[candidate.lore.uid],
            writeCache: (candidate, cache) => { nextCache[candidate.lore.uid] = cache; cacheChanged = true; },
        });
        if (isCurrentOperation(owner) && cacheChanged) await saveLorebookEmbeddingCache(nextCache);
        const separator = resolveInjectionText(lorebookSeparator);
        const separatorTokens = separator ? await countMemoryTokens(separator) : 0;
        for (const target of targets) {
            const ranked = candidates
                .filter((candidate) => candidate.positions.includes(target) && candidate.embedding)
                .map((candidate) => ({
                candidate,
                score: cosineSimilarity(queryEmbedding, candidate.embedding),
            }))
                .filter((row) => row.score >= 0.05)
                .sort((a, b) => b.score - a.score);
            const budgetItems = [];
            for (const row of ranked)
                budgetItems.push({ candidate: row.candidate, tokens: await countMemoryTokens(row.candidate.content) });
            const selected = selectWithinTokenBudget(budgetItems, maxLorebookTokens, separatorTokens, "skip")
                .items.map(item => item.candidate);
            // Relevance chooses the set; native lorebook insertion order controls the
            // final readable arrangement inside that position.
            selected.sort((a, b) => a.lore.insertOrder - b.lore.insertOrder ||
                a.lore.source.localeCompare(b.lore.source) ||
                a.lore.sourceIndex - b.lore.sourceIndex);
            contexts.set(target, selected.map((candidate) => candidate.content).join(separator));
        }
        return contexts;
    }
    function replaceLorebookPositionPlaceholdersInMessages(messages, contexts) {
        let hits = 0;
        for (let i = 0; i < messages.length; i++) {
            const content = messages[i].content;
            const regex = makeLorebookPositionPlaceholderRegex();
            if (!regex.test(content))
                continue;
            messages[i] = {
                ...messages[i],
                content: content.replace(makeLorebookPositionPlaceholderRegex(), (_match, rawTarget) => {
                    hits += 1;
                    return contexts.get(String(rawTarget).trim()) ?? "";
                }),
            };
        }
        return hits;
    }
    // ── Message Tracking ─────────────────────────────────────────────────────
    function trackUserMessage() { invalidateUiSessionRenderData(); }
    function trackAssistantMessage() { invalidateUiSessionRenderData(); }
    /**
     * The injection block only decides placement. {{hypa}} and {{chosen}} are
     * resolved later across the fully flattened request, so the same placeholders
     * also work when written directly in a RisuAI prompt or lorebook.
     * An empty block disables plugin-side block insertion without disabling direct placeholders.
     */
    function renderMemoryInjectionTemplate(template = memoryInjectionTemplate) {
        return resolveInjectionText(template);
    }
    function countContextPlaceholderHits(messages) {
        let hypaHits = 0;
        let chosenHits = 0;
        for (const message of messages) {
            if (message.role === "system") {
                hypaHits += message.content.split(HYPA_CONTEXT_PLACEHOLDER).length - 1;
            }
            chosenHits += message.content.split(CHOSEN_CONTEXT_PLACEHOLDER).length - 1;
        }
        return { hypaHits, chosenHits };
    }
    function isRisuMemoryToggleEnabled() {
        return getDetectedChatUiMetadataForCurrentContext()?.risuMemoryToggleEnabled === true;
    }
    function suspendAutoSummaryRequestTrackingForNativeMemory() {
        const discardedProbeCount = autoSummaryRequestProbes.length;
        autoSummaryRequestProbes = [];
        // Invalidate delayed reconciliation callbacks from the previous Hypirk-owned
        // request. Persisted autoSummaryPending is intentionally left untouched so it
        // can remain dormant while native memory is enabled and resume when disabled.
        autoSummaryReconcileGeneration += 1;
        if (discardedProbeCount > 0) {
            console.log(`[Hypirk] Risu memory toggle ON; discarded ${discardedProbeCount} automatic-summary request probe(s).`);
        }
    }
    function replaceContextPlaceholdersInMessages(messages, hypaContext, chosenContext) {
        let hypaHits = 0;
        let chosenHits = 0;
        for (let i = 0; i < messages.length; i++) {
            const content = messages[i].content;
            const replaceHypa = messages[i].role === "system";
            const hypaCount = replaceHypa ? content.split(HYPA_CONTEXT_PLACEHOLDER).length - 1 : 0;
            const chosenCount = content.split(CHOSEN_CONTEXT_PLACEHOLDER).length - 1;
            if (hypaCount === 0 && chosenCount === 0)
                continue;
            hypaHits += hypaCount;
            chosenHits += chosenCount;
            messages[i] = {
                ...messages[i],
                content: replaceAllLiteral(replaceHypa ? replaceAllLiteral(content, HYPA_CONTEXT_PLACEHOLDER, hypaContext) : content, CHOSEN_CONTEXT_PLACEHOLDER, chosenContext),
            };
        }
        return { hypaHits, chosenHits };
    }
    /**
     * Locate the observed flattened-request boundary: the first system message,
     * followed by the first non-system message after the initial system section.
     */
    function findSystemHistoryBoundary(messages) {
        const firstSystemIndex = messages.findIndex((message) => message.role === "system");
        if (firstSystemIndex < 0)
            return null;
        const relativeNonSystemIndex = messages
            .slice(firstSystemIndex + 1)
            .findIndex((message) => message.role !== "system");
        if (relativeNonSystemIndex < 0)
            return null;
        return {
            firstSystemIndex,
            firstNonSystemIndex: firstSystemIndex + 1 + relativeNonSystemIndex,
        };
    }
    /**
     * Diagnostic only. The inferred boundary is never changed based on this check.
     * It simply reports whether the surviving non-system messages look like an
     * alternating user/assistant chat history.
     */
    function diagnoseHistoryRoleAlternation(messages, firstNonSystemIndex) {
        const roles = messages.slice(firstNonSystemIndex).map((message) => message.role);
        if (roles.length === 0)
            return;
        let issue = "";
        for (let i = 0; i < roles.length; i++) {
            const role = roles[i];
            if (role !== "user" && role !== "assistant") {
                issue = `unexpected role '${role}' at history offset ${i}`;
                break;
            }
            if (i > 0 && roles[i - 1] === role) {
                issue = `non-alternating roles '${role}' -> '${role}' at history offsets ${i - 1}/${i}`;
                break;
            }
        }
        if (issue) {
            console.warn(`[Hypirk] Inferred system/history boundary diagnostic: ${issue}`, roles);
        }
        else {
            console.log(`[Hypirk] Inferred system/history boundary: history starts with ${roles[0]}, ${roles.length} non-system messages alternate normally`);
        }
    }
    function escapeRegexLiteral(text) {
        return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    /**
     * Injection anchor and memory block are deliberately separate:
     * - anchor: an existing string in the flattened system prompt
     * - template: the memory block to insert immediately BEFORE that anchor
     *
     * The configured anchor is searched in every system message in array order.
     * If it is absent, the observed system/history boundary is used as fallback.
     * No alternative anchor is inferred.
     */
    function injectMemoryAtHistoryBoundary(messages, profile) {
        const renderedTemplate = renderMemoryInjectionTemplate(profile.template);
        if (!renderedTemplate)
            return "none";
        const anchor = resolveInjectionText(profile.anchor);
        if (anchor.length > 0) {
            for (let i = 0; i < messages.length; i++) {
                if (messages[i].role !== "system")
                    continue;
                const matchIndex = messages[i].content.indexOf(anchor);
                if (matchIndex < 0)
                    continue;
                messages[i] = {
                    ...messages[i],
                    content: messages[i].content.slice(0, matchIndex) +
                        renderedTemplate +
                        messages[i].content.slice(matchIndex),
                };
                console.log(`[Hypirk] Memory injected before configured anchor: message=${i}, index=${matchIndex}, matchedLength=${anchor.length}`);
                return "configured-anchor-before";
            }
            console.warn(`[Hypirk] Configured memory injection anchor was not found in any system message; using system/history boundary`);
        }
        const boundary = findSystemHistoryBoundary(messages);
        if (!boundary) {
            console.warn("[Hypirk] Could not find first system -> first non-system boundary; memory not injected");
            return "boundary-not-found";
        }
        diagnoseHistoryRoleAlternation(messages, boundary.firstNonSystemIndex);
        messages.splice(boundary.firstNonSystemIndex, 0, {
            role: "system",
            content: renderedTemplate,
        });
        return anchor ? "configured-anchor-not-found-boundary-insert" : "boundary-system-insert";
    }
    // beforeRequest: inject memory context + track user messages
    async function beforeRequestHandler(messages, type) {
        if ((type !== "main" && type !== "model") || isSummarizing) return messages;
        try {
            await refreshChatContextForRequestBurst();
            return await withChatOperation(() => beforeRequestInContext(messages, type));
        }
        catch (error) {
            console.error("[Hypirk] Request context failed:", error);
            return messages;
        }
    }
    async function beforeRequestInContext(messages, type) {
        // Only process main chat requests — skip auxiliary model calls (memory, emotion, translate, etc.)
        if (type !== "main" && type !== "model") {
            return messages;
        }
        // Guard against re-entry during summarization
        if (isSummarizing) {
            return messages;
        }
        let stage = "start";
        try {
            // One full charId + chat.id identity check per request burst. If process
            // already performed it for this request, the shared burst gate reuses it.
            stage = "chat-context-ready";
            // RisuAI reuses character.supaMemory for its long-term-memory toggle,
            // including HypaMemory V3. While that toggle is ON, Hypirk remains
            // available as a management/manual-summary tool, but its automatic memory
            // runtime is suspended: no automatic-summary pressure measurement, no
            // automatic summary, no raw-chat pruning, and no MemoryEntry retrieval.
            // Position-scoped lorebook retrieval stays independent.
            stage = "read-risu-memory-toggle";
            const risuMemoryToggleEnabled = isRisuMemoryToggleEnabled();
            // Normally the process hook has already reconciled the previous request
            // and run any pending automatic summaries. Keep a fallback reconciliation
            // here for request paths that skip the process hook, but only while Hypirk
            // owns the automatic-memory runtime. A newly-set pending flag is
            // intentionally left for the next process phase so we never try to prune
            // a messages[] array that Risu has already assembled.
            if (!risuMemoryToggleEnabled) {
                await reconcileAutoSummaryUsage("beforeRequest-fallback");
            }
            // Find the last user message for tracking and retrieval
            stage = "find-last-user";
            let lastUserContent = "";
            for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].role === "user") {
                    lastUserContent = messages[i].content;
                    break;
                }
            }
            if (lastUserContent && !risuMemoryToggleEnabled) {
                beginAutoSummaryRequestProbe(messages, lastUserContent);
            }
            if (lastUserContent) {
                // Track the user message
                stage = "track-user-message";
                await trackUserMessage();
                stage = "resolve-injection-profile";
                const promptNamespace = await detectPromptNamespace();
                const requestInjectionProfile = resolveMemoryInjectionProfileForNamespace(promptNamespace);
                console.log(`[Hypirk] Prompt namespace ${promptNamespace ? `'${promptNamespace}'` : "(none)"} -> memory injection profile '${memoryInjectionProfileLabel(requestInjectionProfile.namespace)}'`);
                stage = "scan-placeholders";
                const directHits = countContextPlaceholderHits(messages);
                const renderedInjectionTemplate = renderMemoryInjectionTemplate(requestInjectionProfile.template);
                const templateHits = countContextPlaceholderHits(renderedInjectionTemplate
                    ? [{ role: "system", content: renderedInjectionTemplate }]
                    : []);
                const hasHypaPlaceholder = directHits.hypaHits + templateHits.hypaHits > 0;
                const hasChosenPlaceholder = directHits.chosenHits + templateHits.chosenHits > 0;
                const lorebookPositionTargets = collectLorebookPositionTargets(messages);
                if (!hasHypaPlaceholder && !hasChosenPlaceholder && lorebookPositionTargets.size === 0) {
                    return messages;
                }
                // One raw snapshot and preprocessing pass for both retrieval lanes.
                const retrievalInputs = await buildRetrievalInputs(currentRawMessages);
                let contexts = null;
                if ((hasHypaPlaceholder || hasChosenPlaceholder) && !risuMemoryToggleEnabled) {
                    stage = "build-memory-contexts";
                    contexts = await buildMemoryContexts(lastUserContent, hasChosenPlaceholder, retrievalInputs);
                }
                else if (risuMemoryToggleEnabled) {
                    // Consume only placeholders already present in the flattened request.
                    // The configured Hypirk injection template is not inserted at all, so
                    // its {{hypa}}/{{chosen}} markers never enter the request.
                    stage = "clear-memory-placeholders";
                    const clearedHits = replaceContextPlaceholdersInMessages(messages, "", "");
                    console.log(`[Hypirk] Risu memory toggle ON; skipped Hypirk memory retrieval/injection and cleared direct placeholders: hypa=${clearedHits.hypaHits}, chosen=${clearedHits.chosenHits}`);
                }
                // Plugin-side block insertion is optional. Direct placeholders in prompts
                // or lorebooks continue to work when the configured block is empty.
                stage = "inject-memory-block";
                const shouldInjectMemoryBlock = Boolean(renderedInjectionTemplate &&
                    (templateHits.hypaHits || templateHits.chosenHits) &&
                    contexts &&
                    (contexts.hypaContext || contexts.chosenContext));
                if (shouldInjectMemoryBlock && contexts) {
                    const memoryInjectionMode = injectMemoryAtHistoryBoundary(messages, requestInjectionProfile);
                    console.log(`[Hypirk] Memory block injected: ${memoryInjectionMode}`);
                }
                if (contexts) {
                    stage = "replace-placeholders";
                    const placeholderHits = replaceContextPlaceholdersInMessages(messages, contexts.hypaContext, contexts.chosenContext);
                    const hypaPlaceholderHits = placeholderHits.hypaHits;
                    const chosenPlaceholderHits = placeholderHits.chosenHits;
                    if (hypaPlaceholderHits || chosenPlaceholderHits) {
                        console.log(`[Hypirk] Context placeholders replaced: hypa=${hypaPlaceholderHits}, chosen=${chosenPlaceholderHits}, recent=${contexts.recentNodeCount} (${contexts.recentEstimatedTokens}/${contexts.recentBudget} est. tokens), chosenBudget=${contexts.chosenBudget}`);
                    }
                }
                if (lorebookPositionTargets.size > 0) {
                    stage = "build-position-lorebook-contexts";
                    const lorebookContexts = await buildPositionLorebookContexts(lorebookPositionTargets, lastUserContent, retrievalInputs);
                    stage = "replace-position-placeholders";
                    const positionHits = replaceLorebookPositionPlaceholdersInMessages(messages, lorebookContexts);
                    console.log(`[Hypirk] Lorebook position placeholders replaced: hits=${positionHits}, targets=${[...lorebookPositionTargets].join(",")}`);
                }
            }
        }
        catch (e) {
            // Return messages unchanged on error — don't block the main request.
            console.error(`[Hypirk] beforeRequest memory injection failed at ${stage}:`, e);
        }
        return messages;
    }
    // afterRequest: track assistant responses
    async function afterRequestHandler(content, type) {
        // Match beforeRequest's main-chat classification. Auxiliary model calls do
        // not add a chat message, so saving state or triggering auto-summarization
        // for their output is unnecessary and can be particularly expensive.
        if (type !== "main" && type !== "model") {
            return content;
        }
        // A completed main-model request is a definitive boundary: the next
        // process/beforeRequest chain must establish a fresh reusable result.
        resetProcessChatMapReuse("after-request");
        if (content) {
            try {
                await trackAssistantMessage();
            }
            catch (e) {
                // Do not block the completed main response if tracking fails.
            }
        }
        // Tracking stays active under Risu/HypaV3 memory, but automatic-summary
        // accounting is suspended with the rest of Hypirk's automatic memory runtime.
        const risuMemoryToggleEnabled = isRisuMemoryToggleEnabled();
        if (!risuMemoryToggleEnabled) {
            const completedProbe = [...autoSummaryRequestProbes].reverse().find((probe) => !probe.completedAt && probe.charId === currentCharId && probe.chatId === currentChatId);
            if (completedProbe) {
                completedProbe.completedAt = Date.now();
                scheduleAutoSummaryUsageReconciliation(completedProbe.id);
            }
        }
        return content;
    }
    function getReadingTypography() {
        // Practical reading scale: the memory view is an editing/reading surface,
        // so keep even the compact preset comfortably legible on desktop and mobile.
        switch (readingScale) {
            case 1: return { body: 15, dialogue: 14 };
            case 1.1: return { body: 15.5, dialogue: 14.5 };
            case 1.2: return { body: 16, dialogue: 15 };
            default: return { body: 14.5, dialogue: 13.5 };
        }
    }
    function getReadingFontFamilyCss() {
        switch (readingFontFamily) {
            case "ridi_batang":
                return '"RIDIBatang","Noto Serif KR","Nanum Myeongjo",serif';
            case "bookk_myungjo":
                return '"BookkMyungjo","RIDIBatang","Noto Serif KR",serif';
            default:
                return '-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans KR","Apple SD Gothic Neo",sans-serif';
        }
    }
    function ensureReadingFonts() {
        if (!document.getElementById("hypirk-ridi-batang")) {
            const link = document.createElement("link");
            link.id = "hypirk-ridi-batang";
            link.rel = "stylesheet";
            link.href = "https://cdn.jsdelivr.net/gh/fonts-archive/RIDIBatang/RIDIBatang.css";
            document.head.appendChild(link);
        }
        if (!document.getElementById("hypirk-bookk-myungjo")) {
            const style = document.createElement("style");
            style.id = "hypirk-bookk-myungjo";
            style.textContent = `@font-face{font-family:'BookkMyungjo';src:url('https://cdn.jsdelivr.net/gh/projectnoonnu/noonfonts_2302@1.0/BookkMyungjo-Bd.woff2') format('woff2');font-weight:700;font-style:normal;font-display:swap;}`;
            document.head.appendChild(style);
        }
    }
    let activeTab = "nodes";
    let lorebookPageContext = null;
    let lorebookPageLoading = false;
    let lorebookPageError = "";
    const translatingNodeIds = new Set();
    let nodeListPage = 0;
    let nodeSearchQuery = "";
    let nodeSearchDraft = "";
    let showChosenNodesOnly = false;
    let cardInlineEditMode = false;
    const memoryUndoStack = [];
    const memoryRedoStack = [];
    function updateMemoryHistoryButtons() {
        for (const [selector, stack] of [[".hp-memory-undo", memoryUndoStack], [".hp-memory-redo", memoryRedoStack]]) {
            const button = document.querySelector(selector);
            if (button)
                button.disabled = !stack.some(edit => findNodeById(edit.node.id) === edit.node);
        }
    }
    function recordMemoryEdit(node, field, before, after) {
        if (JSON.stringify(before) === JSON.stringify(after))
            return;
        memoryUndoStack.push({ node, field, before: structuredClone(before), after: structuredClone(after) });
        if (memoryUndoStack.length > 300)
            memoryUndoStack.shift();
        memoryRedoStack.length = 0;
        updateMemoryHistoryButtons();
    }
    // All field edits share identity checks, invalidation and persistence scheduling.
    function editMemory(node, updates, { history = false, deferred = true } = {}) {
        if (findNodeById(node.id) !== node) return false;
        let changed = false;
        for (const [field, value] of Object.entries(updates)) {
            const before = node[field];
            if (JSON.stringify(before) === JSON.stringify(value)) continue;
            const next = structuredClone(value);
            if (history) recordMemoryEdit(node, field, before, next);
            if (next === undefined) delete node[field];
            else node[field] = next;
            // Both narration and quoted dialogue derive from content.
            if (field === "content") clearNodeEmbedding(node);
            changed = true;
        }
        if (changed && deferred) scheduleInlineNodeSave(node);
        return changed;
    }
    async function commitMemoryEdit(node, updates) {
        if (editMemory(node, updates, { deferred: false })) await saveState();
    }
    function replaceMemoryFromSummary(entry, memory) {
        if (!state.entries.includes(entry) || !entry.memory) return false;
        const old = entry.memory;
        entry.memory = { ...memory, id: old.id, favorite: old.favorite, likedAt: old.likedAt,
            category: old.category, tags: old.tags, activationCues: old.activationCues };
        markEmbeddingCacheDirty();
        return true;
    }
    async function applyMemoryHistory(redo) {
        const source = redo ? memoryRedoStack : memoryUndoStack;
        const destination = redo ? memoryUndoStack : memoryRedoStack;
        let edit;
        while ((edit = source.pop())) {
            if (findNodeById(edit.node.id) === edit.node)
                break;
        }
        if (!edit) {
            updateMemoryHistoryButtons();
            return;
        }
        const node = edit.node;
        const value = structuredClone(redo ? edit.after : edit.before);
        editMemory(node, { [edit.field]: value });
        destination.push(edit);
        await renderUI(true);
    }
    const selectedMemoryEntries = new Set();
    let bulkEntryActionInProgress = false;
    let nodeSearchOpen = false;
    // Editor persistence outlives a DOM render. Dirty revisions protect edits made
    // while an earlier write is in flight; failed writes retain the dirty set.
    const INLINE_SAVE_DELAY_MS = 3000;
    const inlineDirtyNodes = new Map();
    let inlineEditRevision = 0;
    let inlineSaveTimer = null;
    let inlineSaveQueue = Promise.resolve();
    let inlineSaveStatus = "idle";
    function showInlineSaveStatus(status) {
        inlineSaveStatus = status;
        const element = document.getElementById("hp-inline-save-status");
        if (!element)
            return;
        element.hidden = status === "idle";
        element.textContent = status === "error"
            ? "저장 실패 · 다음 편집 또는 닫을 때 다시 시도합니다."
            : "저장 중…";
    }
    function cancelInlineSaveTimer() {
        if (inlineSaveTimer !== null)
            window.clearTimeout(inlineSaveTimer);
        inlineSaveTimer = null;
    }
    function persistDirtyInlineNodes() {
        const task = inlineSaveQueue.then(async () => {
            // Deleted/replaced memories must not be resurrected by an old editor.
            const liveNodes = new Set(getNodes());
            for (const node of inlineDirtyNodes.keys()) {
                if (!liveNodes.has(node))
                    inlineDirtyNodes.delete(node);
            }
            if (!inlineDirtyNodes.size) {
                showInlineSaveStatus("idle");
                return;
            }
            const revisions = new Map(inlineDirtyNodes);
            showInlineSaveStatus("saving");
            try {
                await saveState();
                for (const [node, revision] of revisions) {
                    if (inlineDirtyNodes.get(node) === revision)
                        inlineDirtyNodes.delete(node);
                }
                showInlineSaveStatus("idle");
            }
            catch (error) {
                showInlineSaveStatus("error");
                throw error;
            }
        });
        // Recover the shared queue, while returning the rejecting task to callers.
        inlineSaveQueue = task.catch(() => { });
        return task;
    }
    function scheduleInlineNodeSave(node) {
        inlineDirtyNodes.set(node, ++inlineEditRevision);
        cancelInlineSaveTimer();
        inlineSaveTimer = window.setTimeout(() => {
            inlineSaveTimer = null;
            void persistDirtyInlineNodes().catch((error) => {
                console.error("[Hypirk] Inline save failed; edits retained for retry:", error);
            });
        }, INLINE_SAVE_DELAY_MS);
    }
    async function flushInlineCardChanges() {
        cancelInlineSaveTimer();
        await inlineSaveQueue;
        while (inlineDirtyNodes.size)
            await persistDirtyInlineNodes();
        cancelInlineSaveTimer();
    }
    let manualSummarizationInProgress = false;
    let summarizationPreviewEntry = null;
    let nodeSortDirection = "asc";
    let nodesPerPage = 30;
    let pendingMessagesExpanded = true;
    let showSummarizeDialog = false;
    let showCreateNodeDialog = false;
    let uiSessionRenderData = null;
    let uiSessionRenderDataInFlight = null;
    let uiRenderGeneration = 0;
    function getUiContextKey() {
        return `${currentCharId}\u0000${currentChatId}\u0000${currentCharIndex}\u0000${currentChatIndex}`;
    }
    function invalidateUiSessionRenderData() {
        uiSessionRenderData = null;
        uiSessionRenderDataInFlight = null;
    }
    async function getUiSessionRenderData() {
        const contextKey = getUiContextKey();
        if (uiSessionRenderData?.contextKey === contextKey)
            return uiSessionRenderData;
        if (uiSessionRenderDataInFlight)
            return uiSessionRenderDataInFlight;
        const request = Promise.all([
            getPendingMessages(),
            (async () => {
                if (currentCharIndex < 0 || currentChatIndex < 0) {
                    return { charName: "?", chatName: "?" };
                }
                const detectedMetadata = getDetectedChatUiMetadataForCurrentContext();
                if (detectedMetadata?.charResolved && detectedMetadata.chatResolved) {
                    return {
                        charName: detectedMetadata.charName,
                        chatName: detectedMetadata.chatName,
                    };
                }
                const [char, chat] = await Promise.all([
                    risuai.getCharacterFromIndex(currentCharIndex).catch(() => null),
                    risuai.getChatFromIndex(currentCharIndex, currentChatIndex).catch(() => null),
                ]);
                return {
                    charName: char?.name?.toString() ?? `Char#${currentCharIndex}`,
                    chatName: chat?.name?.toString() ?? `Chat#${currentChatIndex}`,
                };
            })(),
        ]).then(([pendingMessages, names]) => ({
            contextKey,
            pendingMessages,
            ...names,
        }));
        uiSessionRenderDataInFlight = request;
        try {
            const result = await request;
            if (getUiContextKey() === contextKey)
                uiSessionRenderData = result;
            return result;
        }
        finally {
            if (uiSessionRenderDataInFlight === request)
                uiSessionRenderDataInFlight = null;
        }
    }
    // Settings edits belong to the current GUI session, not the retrieval runtime.
    // Deliberately no unload/pagehide handler: refresh discards uncommitted edits.
    const PRESET_FIELDS = ["hp-prompt-textarea", "hp-chunk-size", "hp-summary-retain-messages", "hp-include-user", "hp-embedding-context", "hp-max-tokens", "hp-recent-memory-ratio", "hp-memory-separator", "hp-event-format"];
    const SEARCH_FIELDS = ["hp-query-paragraph-group-size", "hp-dialogue-embedding-weight", "hp-dialogue-local-weight", "hp-activation-cue-weight", "hp-like-bonus-base"];
    const INJECTION_FIELDS = ["hp-memory-injection-namespace", "hp-memory-injection-anchor", "hp-memory-injection-template"];
    const COMMON_FIELDS = ["hp-embedding-url", "hp-embedding-model", "hp-embedding-api-key", "hp-node-translation-url", "hp-node-translation-key", "hp-node-translation-model", "hp-node-translation-language", "hp-node-translation-prompt", "hp-node-translation-max-tokens", "hp-node-translation-temperature", "hp-summarizer-note"];
    const settingsEdits = new Map();
    let settingsBoundaryBusy = false;
    let settingsActionBusy = false;
    let settingsDraftContextKey = "";
    let regexSettingsDraft = null;
    function getRegexSettingsDraft() {
        return regexSettingsDraft ??= {
            rules: JSON.parse(JSON.stringify(regexLibraryCache)),
            ids: [...(state.regexRuleIds ?? [])], dirty: false,
        };
    }
    function clearSettingsEdits(ids) { ids.forEach(id => settingsEdits.delete(id)); }
    function restoreSettingsEdits() {
        for (const [id, edit] of settingsEdits) {
            const field = document.getElementById(id);
            if (field) {
                field.value = edit.value;
                if (field.type === "checkbox")
                    field.checked = edit.checked;
            }
        }
        const workspace = document.querySelector(".hp-settings-workspace");
        const tracked = new Set([...PRESET_FIELDS, ...COMMON_FIELDS, ...INJECTION_FIELDS, ...SEARCH_FIELDS]);
        const record = (event) => {
            const field = event.target;
            if (!tracked.has(field.id))
                return;
            settingsEdits.set(field.id, { value: field.value, checked: field.checked });
            if (SEARCH_FIELDS.includes(field.id)) {
                const status = document.getElementById("hp-search-save-status");
                if (status)
                    status.textContent = "미저장 변경이 있습니다.";
            }
        };
        workspace?.addEventListener("input", record);
        workspace?.addEventListener("change", record);
        const status = document.getElementById("hp-search-save-status");
        if (status && SEARCH_FIELDS.some(id => settingsEdits.has(id)))
            status.textContent = "미저장 변경이 있습니다.";
    }
    function validateSettingsNumbers(ids, editedOnly = true) {
        const labels = {
            "hp-chunk-size": "요약본당 최대 메시지 수",
            "hp-summary-retain-messages": "요약 후 남길 메시지 수",
            "hp-embedding-context": "임베딩 요청 메시지 수",
            "hp-max-tokens": "기억 토큰",
            "hp-node-translation-max-tokens": "번역 최대 출력 토큰",
            "hp-node-translation-temperature": "번역 온도",
            "hp-query-paragraph-group-size": "Query 문단 묶음",
            "hp-dialogue-embedding-weight": "의미 대사",
            "hp-dialogue-local-weight": "어휘 대사",
            "hp-activation-cue-weight": "활성 키",
            "hp-like-bonus-base": "좋아요 기본 보너스",
        };
        const integers = new Set(["hp-chunk-size", "hp-summary-retain-messages", "hp-embedding-context", "hp-max-tokens", "hp-node-translation-max-tokens", "hp-query-paragraph-group-size"]);
        for (const id of ids) {
            if (editedOnly && !settingsEdits.has(id))
                continue;
            const field = document.getElementById(id);
            if (!field || field.type !== "number")
                continue;
            const value = Number(field.value);
            // The step attribute controls spinner increments, not accepted precision.
            // Keep pre-existing unedited values usable, including imported presets.
            const invalid = !field.value.trim() || !Number.isFinite(value)
                || (integers.has(id) && !Number.isInteger(value))
                || (field.min !== "" && value < Number(field.min))
                || (field.max !== "" && value > Number(field.max));
            if (invalid) {
                // Reveal the input if its settings section is collapsed.
                const panel = field.closest(".hp-settings-collapse-content");
                if (panel) {
                    panel.hidden = false;
                    document.querySelector(`[aria-controls="${panel.id}"]`)?.setAttribute("aria-expanded", "true");
                }
                field.focus();
                const range = `${field.min !== "" ? field.min + " 이상" : ""}${field.min !== "" && field.max !== "" ? ", " : ""}${field.max !== "" ? field.max + " 이하" : ""}`;
                alert(`${labels[id] ?? id}: ${integers.has(id) ? "정수" : "숫자"}를 입력해주세요${range ? " (" + range + ")" : ""}. 입력값: ${field.value || "비어 있음"}`);
                return false;
            }
        }
        return true;
    }
    /** Reset transient UI state when starting a new fullscreen GUI session. */
    function resetUiSessionState() {
        settingsEdits.clear();
        regexSettingsDraft = null;
        memoryInjectionDraft = null;
        settingsDraftContextKey = getUiContextKey();
        invalidateUiSessionRenderData();
        activeTab = "nodes";
        lorebookPageContext = null;
        lorebookPageLoading = false;
        lorebookPageError = "";
        translatingNodeIds.clear();
        nodeListPage = 0;
        nodeSearchQuery = "";
        nodeSearchDraft = "";
        const previousSearchInput = document.getElementById("hp-node-search");
        if (previousSearchInput)
            previousSearchInput.value = "";
        showChosenNodesOnly = false;
        cardInlineEditMode = false;
        memoryUndoStack.length = 0;
        memoryRedoStack.length = 0;
        selectedMemoryEntries.clear();
        nodeSearchOpen = false;
        pendingMessagesExpanded = true;
        showSummarizeDialog = false;
        showCreateNodeDialog = false;
    }
    function readLorebookPageEntries(list, source, sourceLabel) {
        if (!Array.isArray(list))
            return [];
        return list.map((rawLore, index) => {
            const lore = rawLore && typeof rawLore === "object"
                ? rawLore
                : {};
            const rawId = lore.id;
            const uid = rawId !== undefined && rawId !== null && String(rawId)
                ? `${source}:id:${String(rawId)}`
                : `${source}:index:${index}`;
            const title = String(lore.comment ?? lore.name ?? lore.key ?? `이름 없는 로어 ${index + 1}`);
            return {
                uid,
                source,
                sourceLabel,
                sourceIndex: index,
                title,
                content: String(lore.content ?? ""),
                alwaysActive: Boolean(lore.alwaysActive),
                mode: String(lore.mode ?? "normal"),
                insertOrder: Number.isFinite(Number(lore.insertorder)) ? Number(lore.insertorder) : 100,
            };
        }).filter((lore) => lore.content.trim().length > 0 &&
            lore.mode !== "folder" &&
            lore.mode !== "child");
    }
    async function loadLorebookPageContext() {
        lorebookPageLoading = true;
        lorebookPageError = "";
        try {
            await ensureChatContext();
            if (currentCharIndex < 0 || currentChatIndex < 0) {
                throw new Error("현재 캐릭터 또는 채팅을 찾을 수 없습니다.");
            }
            const [characterRaw, chatRaw] = await Promise.all([
                risuai.getCharacterFromIndex(currentCharIndex),
                risuai.getChatFromIndex(currentCharIndex, currentChatIndex),
            ]);
            if (!characterRaw)
                throw new Error("현재 캐릭터를 찾을 수 없습니다.");
            if (!chatRaw)
                throw new Error("현재 채팅을 찾을 수 없습니다.");
            const character = characterRaw;
            const chat = chatRaw;
            const lores = [
                ...readLorebookPageEntries(character.globalLore, "character", "캐릭터"),
                ...readLorebookPageEntries(chat.localLore, "chat", "채팅"),
            ];
            lorebookPageContext = {
                contextKey: getUiContextKey(),
                characterName: String(character.name ?? `Char#${currentCharIndex}`),
                chatName: String(chat.name ?? `Chat#${currentChatIndex}`),
                lores,
            };
        }
        catch (error) {
            lorebookPageContext = null;
            lorebookPageError = error instanceof Error ? error.message : String(error);
        }
        finally {
            lorebookPageLoading = false;
        }
    }
    async function openSettings() {
        await flushInlineCardChanges();
        // Card/budget estimates render synchronously, so finish the shared tokenizer
        // warm-up before opening the GUI. Failure is visible as heuristic fallback.
        await ensureO200kMemoryTokenizer();
        // Auto-load current chat state before showing GUI (gracefully handle no chat)
        try {
            await ensureChatContext();
            const messages = await readChatMessagesRaw();
            await reconcileMessageLinks(messages);
        }
        catch (e) {
            console.log("[Hypirk] Could not load chat context for GUI:", e);
        }
        // Build a fresh Nodes-tab UI while the container is still hidden. This
        // prevents the previous session from flashing before the reset appears.
        resetUiSessionState();
        await renderUI(false);
        await risuai.showContainer("fullscreen");
    }
    function renderUI(preserveScroll = true, savedScrollTop) {
        const searchInput = document.getElementById("hp-node-search");
        if (searchInput)
            nodeSearchDraft = searchInput.value;
        const renderGeneration = ++uiRenderGeneration;
        // The UI is rebuilt with innerHTML on every update, so preserve the
        // scroll position when refreshing the current tab.
        const previousBody = document.getElementById("hp-body");
        const previousScrollTop = preserveScroll ? (savedScrollTop ?? previousBody?.scrollTop ?? null) : null;
        // Expensive Risu reads are shared for the lifetime of this fullscreen UI.
        return getUiSessionRenderData().then(({ pendingMessages, charName, chatName }) => {
            if (renderGeneration !== uiRenderGeneration) {
                return;
            }
            renderUIWithPending(pendingMessages, charName, chatName, previousScrollTop);
        }).catch((error) => {
            throw error;
        });
    }
    function scrollUiBodyToTop() {
        const body = document.getElementById("hp-body");
        if (body)
            body.scrollTop = 0;
    }
    function selectMainTabWithoutRender(nextTab) {
        activeTab = nextTab;
        document.querySelectorAll(".hp-panel[data-panel]").forEach((panel) => {
            panel.classList.toggle("active", panel.dataset.panel === nextTab);
        });
        scrollUiBodyToTop();
    }
    /** Translation controls refresh card content without changing the user's reading position. */
    function renderTranslationUI() {
        return renderUI(true);
    }
    function renderUIWithPending(pendingMessages, charName, chatName, restoreScrollTop) {
        withMemoryReadCache(() => renderUIWithPendingCached(pendingMessages, charName, chatName, restoreScrollTop));
    }
    function renderUIWithPendingCached(pendingMessages, charName, chatName, restoreScrollTop) {
        settingsHelpSequence = 0;
        currentUiTimelineDetection = detectCurrentTimelineDate();
        ensureMaterialSymbolsFont();
        ensureReadingFonts();
        toolbarMenuEvents?.abort();
        document.body.innerHTML = `
      <style>
        :root { ${getUiPaletteCssVariables()} --hp-reading-body:${getReadingTypography().body}px; --hp-reading-dialogue:${getReadingTypography().dialogue}px; --hp-reading-font:${getReadingFontFamilyCss()}; }
      </style>
      <style>
        :root { color-scheme:var(--hp-color-scheme); accent-color:var(--hp-primary); --hp-ui-font:14px; --hp-ui-font-small:13px; --hp-ui-font-meta:12px; --hp-border-width:1.5px; --hp-border-width-subtle:1.25px; }
        html, body { width:100%; height:100%; }
        body { margin:0; display:flex; align-items:center; justify-content:center; overflow:hidden; background:var(--hp-page-backdrop); }
        .hp-wrap { box-sizing:border-box; display:flex; flex-direction:column; width:50vw; height:100vh; max-width:100vw; max-height:100vh; overflow:visible; border:var(--hp-border-width) solid var(--hp-border); border-radius:var(--hp-radius-modal); box-shadow:0 18px 48px rgba(0,0,0,.35); color:var(--hp-text); font-family:var(--hp-reading-font); background:var(--hp-background); }
        .hp-wrap button, .hp-wrap input, .hp-wrap select, .hp-wrap textarea { font-family:inherit; }
        .hp-tabs { position:sticky; top:0; z-index:60; display:flex; align-items:center; gap:7px; min-height:38px; padding:2px 6px; border-bottom:var(--hp-border-width) solid var(--hp-border); flex-shrink:0; background:var(--hp-top-tabs-background); }
        .hp-tabs::after { content:attr(data-version-label); position:absolute; z-index:1; top:2px; right:52px; color:var(--hp-text-muted); font-size:9px; font-weight:normal; line-height:1; text-align:right; white-space:nowrap; pointer-events:none; }
        .hp-memory-subbar { position:sticky; top:38px; z-index:58; display:flex; align-items:center; gap:5px; min-height:38px; padding:3px 7px; border-bottom:var(--hp-border-width) solid var(--hp-border); flex-shrink:0; background:var(--hp-surface); }
        .hp-memory-edit-toggle { box-sizing:border-box; flex:0 0 112px; width:112px; margin:0; }
        .hp-memory-subbar .hp-chosen-stat-toggle { flex:0 1 auto; min-width:0; margin:0; padding:6px 9px; white-space:nowrap; }
        .hp-memory-subbar-spacer { flex:1 1 auto; min-width:0; }
        .hp-main-nav { position:relative; display:flex; align-items:center; gap:2px; flex:0 1 auto; min-width:0; }
        .hp-main-nav-button { appearance:none; display:inline-flex; align-items:center; justify-content:center; min-height:30px; padding:3px 7px; border:0; border-radius:var(--hp-radius-sm); background:transparent; color:var(--hp-top-tab-text); font:inherit; font-size:var(--hp-ui-font); font-weight:700; cursor:pointer; }
        .hp-main-nav-button:hover { background:var(--hp-secondary); color:var(--hp-top-tab-hover-text); }
        .hp-main-nav-button.active { background:var(--hp-secondary); color:var(--hp-text-strong); font-weight:800; box-shadow:inset 0 -2px 0 var(--hp-primary); }
        .hp-main-nav-separator { flex:0 0 auto; color:var(--hp-text-muted); font-size:12px; line-height:1; opacity:.65; user-select:none; }
        .hp-topbar-spacer { flex:1 1 auto; min-width:4px; }
        .hp-lorebook-workspace { display:grid; gap:12px; }
        .hp-lorebook-header { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
        .hp-lorebook-header-copy { flex:1 1 220px; min-width:0; }
        .hp-lorebook-header-copy h3 { margin:0 0 4px; color:var(--hp-text-strong); font-size:17px; }
        .hp-lorebook-header-copy p { margin:0; color:var(--hp-text-muted); font-size:var(--hp-ui-font-small); line-height:1.45; }
        .hp-lorebook-summary { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
        .hp-lorebook-retrieval-settings { display:grid; gap:9px; padding:12px; border:var(--hp-border-width-subtle) solid var(--hp-border); border-radius:var(--hp-radius-md); background:var(--hp-surface); }
        .hp-lorebook-retrieval-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
        .hp-lorebook-retrieval-row .hp-label { min-width:112px; }
        .hp-lorebook-retrieval-row .hp-input { flex:1 1 180px; min-width:0; }
        .hp-lorebook-retrieval-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
        .hp-lorebook-save-status { color:var(--hp-text-muted); font-size:var(--hp-ui-font-small); }
        .hp-lorebook-list { display:grid; gap:8px; }
        .hp-lorebook-entry { padding:11px 12px; border:var(--hp-border-width-subtle) solid var(--hp-border); border-radius:var(--hp-radius-md); background:var(--hp-surface); }
        .hp-lorebook-entry-head { display:flex; align-items:center; gap:7px; flex-wrap:wrap; margin-bottom:7px; }
        .hp-lorebook-source { flex:0 0 auto; padding:3px 6px; border-radius:999px; background:var(--hp-secondary); color:var(--hp-text-strong); font-size:11px; font-weight:800; }
        .hp-lorebook-source.chat { background:color-mix(in srgb,var(--hp-primary) 16%,var(--hp-secondary)); }
        .hp-lorebook-entry-title { flex:1 1 180px; min-width:0; color:var(--hp-text-strong); font-size:var(--hp-ui-font); font-weight:800; overflow-wrap:anywhere; }
        .hp-lorebook-entry-state { color:var(--hp-primary); font-size:11px; font-weight:800; }
        .hp-lorebook-entry-content { color:var(--hp-text); font-size:var(--hp-ui-font-small); line-height:1.55; white-space:pre-wrap; overflow-wrap:anywhere; }
        .hp-lorebook-empty, .hp-lorebook-status { padding:14px; border:var(--hp-border-width-subtle) dashed var(--hp-border); border-radius:var(--hp-radius-md); color:var(--hp-text-muted); font-size:var(--hp-ui-font-small); text-align:center; }
        .hp-lorebook-status.error { color:var(--hp-danger); border-color:color-mix(in srgb,var(--hp-danger) 50%,var(--hp-border)); }
        .hp-toolbar-ui { position:relative; flex:0 0 auto; }
        .hp-ui-menu-button { appearance:none; display:inline-flex; align-items:center; justify-content:center; gap:8px; min-width:54px; min-height:30px; padding:3px 8px; border:0; border-radius:var(--hp-radius-sm); background:transparent; color:var(--hp-text); font:inherit; font-size:var(--hp-ui-font); font-weight:700; cursor:pointer; }
        .hp-ui-menu-button:hover, .hp-ui-menu-button[aria-expanded="true"] { background:var(--hp-secondary); color:var(--hp-text-strong); }
        .hp-ui-menu-chevron { width:6px; height:6px; border-right:1.5px solid currentColor; border-bottom:1.5px solid currentColor; transform:translateY(-2px) rotate(45deg); transition:transform .15s; }
        .hp-ui-menu-button[aria-expanded="true"] .hp-ui-menu-chevron { transform:translateY(2px) rotate(225deg); }
        .hp-search-toggle { appearance:none; flex:0 0 30px; width:30px; height:30px; padding:0; border:0; border-radius:var(--hp-radius-sm); background:transparent; color:var(--hp-text-control); font-size:17px; cursor:pointer; }
        .hp-search-toggle:hover, .hp-search-toggle[aria-expanded="true"] { background:var(--hp-secondary); color:var(--hp-text-strong); }
        .hp-search-overlay { position:absolute; z-index:59; top:100%; left:0; right:0; display:flex; align-items:center; gap:6px; padding:8px; border-bottom:var(--hp-border-width) solid var(--hp-border); background:var(--hp-surface); box-shadow:0 7px 16px rgba(0,0,0,.2); }
        .hp-search-overlay[hidden] { display:none; }
        .hp-search-overlay .hp-input { flex:1 1 auto; width:100%; max-width:none; }
        .hp-settings-panel + .hp-settings-panel { margin-top:24px; }
        .hp-settings-heading-row { display:flex; align-items:center; justify-content:space-between; gap:12px; }
        .hp-settings-workspace { --hp-settings-label-column:minmax(0,38%); --hp-settings-control-column:minmax(0,62%); --hp-settings-compact-control-width:42%; }
        .hp-row.hp-settings-form-row { display:grid; grid-template-columns:var(--hp-settings-label-column) var(--hp-settings-control-column); row-gap:5px; column-gap:14px; align-items:center; margin:10px 0; }
        .hp-settings-form-row > .hp-label { grid-column:1; grid-row:1; min-width:0; line-height:1.35; }
        .hp-settings-form-row > .hp-input,
        .hp-settings-form-row > .hp-select,
        .hp-settings-form-row > .hp-toggle { grid-column:2; grid-row:1; }
        .hp-settings-form-row > .hp-input,
        .hp-settings-form-row > .hp-select { width:100% !important; max-width:none; }
        .hp-settings-form-row > .hp-settings-row-hint { grid-column:2; grid-row:2; min-width:0; color:var(--hp-text-muted); font-size:var(--hp-ui-font-meta); line-height:1.45; overflow-wrap:anywhere; }
        .hp-settings-form-row.hp-settings-form-row-compact > .hp-input,
        .hp-settings-form-row.hp-settings-form-row-compact > .hp-select { width:var(--hp-settings-compact-control-width) !important; max-width:none; justify-self:start; }
        .hp-settings-form-row.hp-settings-form-row-toggle > .hp-toggle { justify-self:start; }
        .hp-settings-field-grid { display:grid; grid-template-columns:minmax(0,1fr); row-gap:5px; min-width:0; margin:12px 0; }
        .hp-settings-field-grid > .hp-label,
        .hp-settings-field-grid > .hp-settings-field-title { margin:0; min-width:0; }
        .hp-settings-field-grid > .hp-field-hint,
        .hp-settings-field-grid > .hp-settings-row-hint { margin:0; min-width:0; }
        .hp-settings-field-grid > .hp-settings-field-actions { margin:0; }
        .hp-label-with-help { display:inline-flex; align-items:center; gap:4px; width:max-content; max-width:100%; }
        .hp-help-wrap { position:relative; display:inline-flex; align-items:center; flex:0 0 auto; }
        .hp-help-button { appearance:none; display:inline-flex; align-items:center; justify-content:center; width:18px; height:18px; margin:0; padding:0; border:0; border-radius:50%; background:transparent; color:color-mix(in srgb,var(--hp-text-muted) 82%,transparent); cursor:help; }
        .hp-help-button:hover, .hp-help-button:focus-visible { background:color-mix(in srgb,var(--hp-secondary) 72%,transparent); color:var(--hp-text-strong); outline:none; }
        .hp-help-button .material-symbols-outlined { font-size:16px; line-height:1; }
        .hp-help-tooltip { position:fixed; z-index:220; width:max-content; max-width:min(300px,calc(100vw - 20px)); padding:7px 9px; border:var(--hp-border-width-subtle) solid var(--hp-border); border-radius:var(--hp-radius-md); background:var(--hp-inset); color:var(--hp-text); box-shadow:0 7px 20px rgba(0,0,0,.28); font-size:var(--hp-ui-font-meta); font-weight:normal; line-height:1.45; text-align:left; overflow-wrap:anywhere; visibility:hidden; opacity:0; pointer-events:auto; transition:opacity .1s,visibility .1s; }
        .hp-help-wrap:hover > .hp-help-tooltip, .hp-help-wrap:focus-within > .hp-help-tooltip { visibility:visible; opacity:1; }
        .hp-settings-workspace .hp-input,
        .hp-settings-workspace .hp-select { min-height:0; padding:5px 9px; border-width:1px; border-color:color-mix(in srgb,var(--hp-control-border) 52%,transparent); }
        .hp-settings-workspace .hp-prompt-field { border-width:1px; border-color:color-mix(in srgb,var(--hp-control-border) 52%,transparent); }
        .hp-debug-mode-control { display:inline-flex; align-items:center; gap:8px; margin-left:auto; }
        .hp-debug-mode-control .hp-label { min-width:0; }
        .hp-memory-ratio-control { padding:8px 0 2px; }
        .hp-memory-ratio-labels, .hp-memory-ratio-estimates { display:flex; align-items:center; justify-content:space-between; gap:8px 16px; }
        .hp-memory-ratio-labels { margin-bottom:8px; color:var(--hp-text-strong); font-size:var(--hp-ui-font); }
        .hp-memory-ratio-estimates { flex-wrap:wrap; margin-top:7px; color:var(--hp-text-muted); font-size:var(--hp-ui-font-small); }
        .hp-memory-ratio-estimates span:last-child { margin-left:auto; text-align:right; }
        .hp-memory-ratio-slider { --hp-memory-split:50%; appearance:none; width:100%; height:14px; margin:0; border:0; border-radius:999px; background:linear-gradient(to right,var(--hp-recent-color) 0 var(--hp-memory-split),var(--hp-similar-color) var(--hp-memory-split) 100%); cursor:default; }
        .hp-memory-ratio-slider::-webkit-slider-thumb { appearance:none; width:18px; height:18px; border:2px solid var(--hp-surface); border-radius:50%; background:var(--hp-text-strong); box-shadow:0 1px 4px rgba(0,0,0,.28); }
        .hp-memory-ratio-slider::-moz-range-thumb { width:16px; height:16px; border:2px solid var(--hp-surface); border-radius:50%; background:var(--hp-text-strong); box-shadow:0 1px 4px rgba(0,0,0,.28); }
        .hp-memory-ratio-slider:focus-visible { outline:2px solid var(--hp-primary); outline-offset:3px; }
        .hp-close-btn { flex:0 0 32px; align-self:center; display:inline-flex; align-items:center; justify-content:center; width:32px; height:30px; margin:0 8px; padding:0; cursor:pointer; border:var(--hp-border-width) solid var(--hp-border); border-radius:var(--hp-radius-lg); background:var(--hp-secondary); color:var(--hp-text-control); transition:background-color .15s,color .15s,border-color .15s; }
        .hp-close-btn:hover { background:var(--hp-danger); border-color:var(--hp-danger); color:var(--hp-text-on-color); }
        .hp-close-btn .material-symbols-outlined { font-size:18px; }
        .hp-body { flex:1; overflow-y:auto; padding:16px; }
        .hp-panel { display:none; }
        .hp-panel.active { display:block; }
        .hp-stat { display:inline-flex; align-items:center; gap:5px; padding:6px 12px; margin:2px 4px; background:var(--hp-surface); border-radius:var(--hp-radius-lg); font-size:var(--hp-ui-font); vertical-align:middle; }
        .hp-stat b { color:var(--hp-text-strong); }
        .hp-stat.hp-chosen-stat-toggle { border:none; color:var(--hp-text); font-family:inherit; cursor:pointer; }
        .hp-stat.hp-chosen-stat-active { background-color:var(--hp-surface); background-image:linear-gradient(var(--hp-similar-stat-overlay),var(--hp-similar-stat-overlay)); }
        .hp-btn { padding:7px 14px; border:none; border-radius:var(--hp-radius-md); cursor:pointer; font-size:var(--hp-ui-font); margin:2px; transition:background-color .15s,color .15s,border-color .15s; vertical-align:middle; }
        .hp-btn.primary { background:var(--hp-primary); color:var(--hp-text-on-color); }
        .hp-btn.primary:hover { background:var(--hp-primary-hover); }
        .hp-btn.danger { background:var(--hp-danger); color:var(--hp-text-on-color); }
        .hp-btn.danger:hover { background:var(--hp-danger-hover); }
        .hp-btn.secondary { background:var(--hp-secondary); color:var(--hp-text-control); }
        .hp-btn.secondary:hover { background:var(--hp-secondary-hover); }
        .hp-btn.small { padding:4px 10px; font-size:var(--hp-ui-font-small); }
        .hp-btn.has-icon { display:inline-flex; align-items:center; justify-content:center; gap:6px; }
        .hp-btn.icon-only { padding:4px 7px; }
        .hp-btn:focus-visible, .hp-fav-node:focus-visible, .hp-like-node:focus-visible, .hp-close-btn:focus-visible:focus-visible { outline:2px solid var(--hp-primary); outline-offset:2px; }
        .hp-btn.hp-orphan-disabled:disabled { background:var(--hp-secondary); opacity:.42; cursor:not-allowed; }
        .hp-btn.hp-node-edit-action, .hp-btn.hp-node-delete-action { background:transparent; border-color:transparent; }
        .hp-btn.hp-node-edit-action { color:var(--hp-node-edit-text); }
        .hp-btn.hp-node-delete-action { color:var(--hp-node-edit-text); }
        .hp-btn.hp-node-edit-action:hover, .hp-btn.hp-node-delete-action:hover { background:var(--hp-secondary-hover); }
        .hp-settings-workspace #hp-save-search-settings { min-height:44px; background:var(--hp-secondary); color:var(--hp-text-control); }
        .hp-settings-workspace #hp-save-search-settings:hover { background:var(--hp-secondary-hover); color:var(--hp-text-strong); }
        .hp-settings-workspace > h3 { margin:24px 0 10px; padding-top:14px; border-top:var(--hp-border-width) solid var(--hp-border); font-size:16px; }
        .hp-settings-workspace > p { font-size:12px; line-height:1.6; color:var(--hp-text-muted); overflow-wrap:anywhere; }
        .hp-btn.hp-popup-save-action { background:var(--hp-popup-save-background); color:var(--hp-popup-save-text); border:var(--hp-border-width) solid var(--hp-popup-save-border); }
        .hp-btn.hp-popup-save-action:hover { background:var(--hp-popup-save-hover-background); }
        .hp-btn.hp-action-manual-summary { background:var(--hp-manual-summary-background); color:var(--hp-manual-summary-text); }
        .hp-btn.hp-action-manual-summary:hover { background:var(--hp-manual-summary-hover-background); }
        .hp-btn.hp-action-manual-node { background:var(--hp-manual-node-background); color:var(--hp-manual-node-text); }
        .hp-btn.hp-action-manual-node:hover { background:var(--hp-manual-node-hover-background); }
        .hp-segmented { display:inline-grid; grid-template-columns:repeat(3, minmax(0, 1fr)); overflow:hidden; border:var(--hp-border-width) solid var(--hp-border); border-radius:var(--hp-radius-md); background:var(--hp-inset); }
        .hp-segmented.hp-segmented-2 { grid-template-columns:repeat(2, minmax(0, 1fr)); }
        .hp-segmented-option { position:relative; min-width:74px; cursor:pointer; }
        .hp-segmented-option + .hp-segmented-option { border-left:var(--hp-border-width) solid var(--hp-border); }
        .hp-segmented-option input { position:absolute; opacity:0; pointer-events:none; }
        .hp-segmented-option span { box-sizing:border-box; display:flex; align-items:center; justify-content:center; min-height:30px; padding:5px 12px; color:var(--hp-text-control); font-size:var(--hp-ui-font-small); line-height:1.2; white-space:nowrap; transition:background-color .15s,color .15s; user-select:none; }
        .hp-segmented-option:hover span { background:var(--hp-secondary-hover); }
        .hp-segmented-option input:checked + span { background:var(--hp-primary); color:var(--hp-text-on-color); }
        .hp-segmented-option input:focus-visible + span { outline:2px solid var(--hp-primary); outline-offset:-2px; }
        .material-symbols-outlined { font-family:"Material Symbols Outlined"; font-weight:normal; font-style:normal; font-size:18px; line-height:1; letter-spacing:normal; text-transform:none; display:inline-block; white-space:nowrap; word-wrap:normal; direction:ltr; -webkit-font-feature-settings:"liga"; font-feature-settings:"liga"; -webkit-font-smoothing:antialiased; font-variation-settings:"FILL" 0,"wght" 400,"GRAD" 0,"opsz" 24; }
        .material-symbols-outlined.hp-icon-edit { font-variation-settings:"FILL" 0,"wght" 300,"GRAD" 0,"opsz" 24; }
        .material-symbols-outlined.hp-icon-delete-filled { font-variation-settings:"FILL" 1,"wght" 400,"GRAD" 0,"opsz" 24; }
        .hp-tab .material-symbols-outlined, .hp-stat .material-symbols-outlined { font-size:16px; }
        .material-symbols-outlined.hp-status-check { color:var(--hp-similar-color); font-variation-settings:"FILL" 1,"wght" 400,"GRAD" 0,"opsz" 24; }
        .material-symbols-outlined.hp-status-bolt { color:var(--hp-recent-color); font-variation-settings:"FILL" 1,"wght" 400,"GRAD" 0,"opsz" 24; }
        .hp-filter-toggle .material-symbols-outlined { font-size:15px; vertical-align:-3px; }
        .hp-icon-label { display:inline-flex; align-items:center; gap:5px; }
        .hp-card { background-color:var(--hp-surface); background-image:none; border:var(--hp-border-width) solid var(--hp-border); border-radius:var(--hp-radius-card); padding:12px; margin:8px 0; }
        /* Memories from the same MemoryEntry read as one continuous card stack. */
        .hp-card.hp-sourcegroup-link-first { margin-bottom:0; border-bottom-style:dashed; border-bottom-left-radius:0; border-bottom-right-radius:0; }
        .hp-card.hp-sourcegroup-link-middle { margin:0; border-top:0; border-bottom-style:dashed; border-radius:0; }
        .hp-card.hp-sourcegroup-link-last { margin-top:0; border-top:0; border-top-left-radius:0; border-top-right-radius:0; }
        .hp-empty-entries { margin-top:12px; padding:0; overflow:hidden; }
        .hp-empty-entries-summary { display:flex; align-items:center; gap:6px; padding:10px 12px; color:var(--hp-text-strong); cursor:pointer; font-size:var(--hp-ui-font-small); font-weight:bold; list-style:none; }
        .hp-empty-entries-summary::-webkit-details-marker { display:none; }
        .hp-empty-entries-summary::before { content:"›"; display:inline-block; flex:0 0 auto; transition:transform .15s; }
        .hp-empty-entries[open] > .hp-empty-entries-summary::before { transform:rotate(90deg); }
        .hp-empty-entries-list { display:flex; flex-direction:column; gap:5px; padding:0 10px 10px; }
        .hp-empty-entry-row { min-width:0; padding:6px 8px; border:var(--hp-border-width) solid var(--hp-border); border-radius:var(--hp-radius-sm); background:var(--hp-inset); }
        .hp-empty-entry-row .hp-node-footer-source { width:100%; }
        .hp-empty-entry-row .hp-source-summary { padding:2px 0; }
        .hp-node-heading { display:inline-flex; align-items:center; flex-wrap:wrap; gap:3px; min-width:0; }
        .hp-node-id-group { display:inline-flex; align-items:center; gap:0; flex:0 0 auto; }
        .hp-card-header { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px; }
        .hp-node-primary-row { width:100%; min-width:0; flex-wrap:nowrap; }
        .hp-node-primary-row .hp-node-heading { flex:1 1 auto; min-width:0; }
        .hp-node-status-slot { display:inline-flex; align-items:center; justify-content:flex-end; flex:0 0 auto; min-width:0; margin-left:auto; }
        .hp-memory-status-badge { display:inline-flex; align-items:center; min-height:20px; padding:3px 10px; border-radius:999px; font-size:11px; font-weight:600; line-height:1; white-space:nowrap; }
        .hp-memory-status-badge.similar { background:var(--hp-similar-badge-background); color:var(--hp-similar-badge-text); }
        .hp-memory-status-badge.recent { background:var(--hp-recent-badge-background); color:var(--hp-recent-badge-text); }
        .hp-node-action-row { display:flex; align-items:center; justify-content:flex-start; gap:3px; width:100%; min-width:0; margin-top:3px; }
        .hp-node-action-left { display:inline-flex; align-items:center; gap:3px; flex:0 0 auto; }
        .hp-node-tag-strip { display:flex; align-items:center; gap:4px; flex:1 1 0; min-width:0; overflow-x:auto; overscroll-behavior-x:contain; max-height:32px; scrollbar-width:thin; }
        .hp-node-tag-strip .hp-proto-tag { flex:0 0 auto; max-width:140px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
        .hp-node-heading .hp-proto-category { flex:0 1 auto; max-width:28%; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
        .hp-metadata-button { display:inline-flex; align-items:center; justify-content:center; flex:0 0 32px; width:32px; height:32px; padding:5px; }
        .hp-metadata-button svg { display:block; width:20px; height:20px; }
        .hp-metadata-dialog { box-sizing:border-box; width:min(440px,calc(100vw - 24px)); max-height:calc(100dvh - 32px); overflow:auto; }
        .hp-metadata-dialog label { display:block; margin:12px 0; }
        .hp-metadata-dialog label span { display:block; margin-bottom:6px; }
        .hp-node-action-meta { display:inline-flex; align-items:center; justify-content:flex-end; gap:4px; flex-wrap:wrap; min-width:0; margin-left:auto; }
        .hp-content { font-family:var(--hp-reading-font); font-size:var(--hp-reading-body); line-height:1.6; margin:6px 0; white-space:pre-wrap; }
        .hp-node-stats { margin-top:6px; min-height:16px; display:flex; align-items:center; gap:6px; font-size:var(--hp-ui-font-meta); }
        .hp-node-similarity { color:var(--hp-similarity-text); }
        .hp-node-dialogue-score { color:var(--hp-text-strong); }
        .hp-score-tooltip { position:relative; cursor:help; outline:none; }
        .hp-score-tooltip::after { content:attr(data-tooltip); position:absolute; z-index:80; left:0; bottom:calc(100% + 6px); display:none; box-sizing:border-box; width:max-content; max-width:min(360px,72vw); padding:7px 9px; border:var(--hp-border-width) solid var(--hp-border); border-radius:var(--hp-radius-sm); background:var(--hp-surface); color:var(--hp-text); box-shadow:0 5px 16px rgba(0,0,0,.24); font-size:var(--hp-ui-font-meta); font-weight:400; line-height:1.4; white-space:pre-wrap; pointer-events:none; }
        .hp-score-tooltip.hp-score-tooltip-open::after { display:block; }
        @media (hover:hover) and (pointer:fine) { .hp-score-tooltip:hover::after { display:block; } }
        .hp-score-separator { color:var(--hp-text-muted); }
        .hp-token-estimate { margin-left:auto; color:var(--hp-text-muted); font-size:var(--hp-ui-font-meta); }
        .hp-content .dl-line { font-size:var(--hp-reading-dialogue); line-height:1.55; }
        .hp-content .dl-speaker { color:var(--hp-dialogue-speaker); }
        .hp-node-translation { box-sizing:border-box; width:auto; min-width:0; margin:0 -12px -12px; padding:10px 12px 12px; border:0; border-radius:0 0 var(--hp-radius-card) var(--hp-radius-card); background:var(--hp-inset); overflow:hidden; }
        .hp-node-translation-head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:6px; color:var(--hp-text-strong); font-size:var(--hp-ui-font-small); font-weight:bold; }
        .hp-node-translation-content { white-space:pre-wrap; line-height:1.6; font-family:var(--hp-reading-font); font-size:var(--hp-reading-body); }
        .hp-node-translation-footer { display:flex; align-items:center; gap:8px; min-height:24px; margin-top:6px; }
        .hp-node-translation-model { margin-left:auto; color:var(--hp-text-muted); font-size:10px; text-align:right; }
        .hp-node-translation-regenerate { flex:0 0 auto; }
        .hp-node-translation-stale { color:var(--hp-danger); font-size:11px; font-weight:normal; }
        .hp-generate-node-translation { opacity:.45; }
        .hp-generate-node-translation:hover, .hp-generate-node-translation:focus-visible { opacity:.62; }
        .hp-toggle-node-translation { min-height:34px; padding:6px 12px !important; margin-bottom:0; }
        .hp-toggle-node-translation[aria-expanded="true"] { position:relative; z-index:2; border-bottom-left-radius:0; border-bottom-right-radius:0; }
        .hp-message-view-tabs { display:flex; align-items:flex-end; gap:4px; flex-wrap:wrap; margin:0 0 7px; border-bottom:var(--hp-border-width) solid var(--hp-border); }
        .hp-message-view-tab { position:relative; bottom:-1px; padding:6px 13px; border:var(--hp-border-width) solid var(--hp-border); border-bottom-color:var(--hp-border); border-radius:var(--hp-radius-sm) var(--hp-radius-sm) 0 0; background:var(--hp-secondary); color:var(--hp-text-muted); cursor:pointer; font-size:var(--hp-ui-font-small); }
        .hp-message-view-tab.active { border-bottom-color:var(--hp-inset); background:var(--hp-inset); color:var(--hp-text-strong); font-weight:bold; }
        .hp-message-cache-status { margin-left:auto; padding:0 4px 6px; color:var(--hp-text-muted); font-size:var(--hp-ui-font-meta); }
        .hp-inline-message-viewer { margin-top:8px; padding:12px; border:var(--hp-border-width) solid var(--hp-border); border-radius:var(--hp-radius-sm); background:var(--hp-background); }
        .hp-inline-message-viewer pre.hp-message-view-content { color:var(--hp-text); }
        .hp-pending-message { cursor:pointer; border-radius:var(--hp-radius-xs); transition:background .15s; }
        .hp-pending-message:hover, .hp-pending-message:focus-visible { background:var(--hp-similar-overlay); outline:none; }
        .hp-input, .hp-textarea, .hp-select { box-sizing:border-box; min-width:0; background:var(--hp-inset); color:var(--hp-text); border:var(--hp-border-width) solid var(--hp-control-border); border-radius:var(--hp-radius-sm); padding:7px 10px; font-size:var(--hp-ui-font); }
        .hp-textarea { width:100%; resize:vertical; font-family:var(--hp-reading-font); font-size:var(--hp-reading-body); line-height:1.55; }
        .hp-settings-collapse { margin:16px 0 8px; overflow:hidden; border:var(--hp-border-width) solid var(--hp-border); border-radius:var(--hp-radius-md); background:var(--hp-surface); }
        .hp-settings-collapse-toggle { appearance:none; display:flex; align-items:center; justify-content:space-between; gap:10px; width:100%; min-height:44px; padding:10px 13px; border:0; background:var(--hp-primary); color:var(--hp-text-on-color); font:inherit; font-size:var(--hp-ui-font); font-weight:bold; text-align:left; cursor:pointer; }
        .hp-settings-collapse-toggle:hover { background:var(--hp-primary-hover); }
        .hp-settings-collapse-toggle:focus-visible { outline:2px solid var(--hp-primary); outline-offset:-3px; }
        .hp-settings-collapse-chevron { flex:0 0 auto; font-size:20px; line-height:1; transition:transform .15s; }
        .hp-settings-collapse-toggle[aria-expanded="true"] .hp-settings-collapse-chevron { transform:rotate(90deg); }
        .hp-settings-collapse-content { padding:10px; border-top:var(--hp-border-width) solid var(--hp-border); }
        .hp-settings-collapse-content[hidden] { display:none; }
        .hp-settings-collapse-content > .hp-row:first-child { margin-top:0; }
        .hp-settings-collapse-content > .hp-row:last-child { margin-bottom:0; }
        .hp-settings-open-box { margin:16px 0 8px; overflow:hidden; border:var(--hp-border-width) solid var(--hp-border); border-radius:var(--hp-radius-md); background:var(--hp-surface); }
        .hp-settings-open-box-title { min-height:44px; padding:10px 13px; display:flex; align-items:center; background:var(--hp-secondary); color:var(--hp-text-strong); font-size:var(--hp-ui-font); font-weight:bold; }
        .hp-settings-open-box-content { padding:10px; border-top:var(--hp-border-width) solid var(--hp-border); }
        .hp-settings-open-box-content > :first-child { margin-top:0; }
        .hp-settings-open-box-content > :last-child { margin-bottom:0; }
        .hp-settings-divider { width:100%; height:0; margin:16px 0; border:0; border-top:var(--hp-border-width) solid var(--hp-border); }
        .hp-input { width:100%; }
        .hp-select { cursor:pointer; }
        .hp-input:focus-visible, .hp-textarea:focus-visible, .hp-select:focus-visible { outline:2px solid var(--hp-primary); outline-offset:1px; }
        .hp-input::placeholder, .hp-textarea::placeholder { color:var(--hp-text-muted); }
        .hp-theme-swatches { display:inline-grid; grid-template-columns:repeat(5,14px); gap:3px; flex-shrink:0; }
        .hp-theme-swatch { box-sizing:border-box; display:block; width:14px; height:14px; border:1px solid rgba(127,127,127,.32); border-radius:var(--hp-radius-swatch); background:var(--hp-theme-swatch); }
        .hp-ui-menu-root, .hp-ui-submenu-panel { box-sizing:border-box; padding:5px; border:var(--hp-border-width) solid var(--hp-border); border-radius:var(--hp-radius-lg); background:var(--hp-surface); box-shadow:0 8px 24px rgba(0,0,0,.28); }
        .hp-ui-menu-item.hp-tools-submenu-trigger, .hp-ui-menu-item.hp-data-submenu-trigger { grid-template-columns:minmax(0,1fr) 18px; }
        .hp-ui-menu-item.hp-data-menu-item, .hp-ui-menu-item.hp-tools-menu-item { grid-template-columns:minmax(0,1fr) 20px; }
        .hp-data-menu-item .material-symbols-outlined, .hp-tools-menu-item .material-symbols-outlined { justify-self:end; color:var(--hp-text-muted); font-size:18px; }
        .hp-tools-menu-item:disabled { opacity:.55; cursor:default; }
        .hp-ui-menu-item.hp-debug-menu-toggle { grid-template-columns:minmax(0,1fr) auto; }
        .hp-debug-menu-toggle input { margin:0; }
        .hp-menu-danger { color:var(--hp-danger); }
        .hp-ui-menu { position:relative; flex:0 0 auto; }
        .hp-ui-menu-root, .hp-ui-submenu-panel { position:fixed; z-index:100; right:auto; bottom:auto; min-width:0; max-width:calc(100vw - 16px); transform:none; overflow-y:auto; overscroll-behavior:contain; }
        .hp-ui-submenu-panel { z-index:101; }
        .hp-ui-menu-item > span:first-child { min-width:0; overflow-wrap:anywhere; }
        .hp-ui-submenu-trigger[data-side="left"] .hp-ui-submenu-arrow { transform:rotate(180deg); }
        .hp-ui-menu-root[hidden], .hp-ui-submenu-panel[hidden] { display:none; }
        .hp-ui-submenu { position:relative; }
        .hp-ui-menu-item { appearance:none; display:grid; grid-template-columns:minmax(0,1fr) auto 18px; align-items:center; gap:8px; width:100%; min-height:40px; padding:8px; border:0; border-radius:var(--hp-radius-xs); background:transparent; color:var(--hp-text); font:inherit; font-size:var(--hp-ui-font-small); text-align:left; cursor:pointer; }
        .hp-ui-menu-item:hover, .hp-ui-menu-item:focus-visible, .hp-ui-menu-item[aria-checked="true"], .hp-ui-submenu-trigger[aria-expanded="true"] { outline:none; background:var(--hp-secondary); color:var(--hp-text-strong); }
        .hp-ui-menu-current { min-width:0; max-width:92px; overflow:hidden; color:var(--hp-text-muted); font-size:var(--hp-ui-font-meta); text-overflow:ellipsis; white-space:nowrap; }
        .hp-ui-menu-check, .hp-ui-submenu-arrow { width:18px; color:var(--hp-text-strong); font-weight:700; text-align:center; }
        .hp-ui-font-sans { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans KR","Apple SD Gothic Neo",sans-serif; }
        .hp-ui-font-ridi_batang { font-family:"RIDIBatang","Noto Serif KR",serif; }
        .hp-ui-font-bookk_myungjo { font-family:"BookkMyungjo","RIDIBatang",serif; font-weight:700; }
        .hp-source-details { flex:1 1 auto; min-width:0; }
        .hp-source-summary { display:flex; align-items:center; gap:5px; width:max-content; max-width:100%; padding:4px 0; color:var(--hp-text-control); font-size:var(--hp-ui-font-small); cursor:pointer; list-style:none; }
        .hp-source-summary::-webkit-details-marker { display:none; }
        .hp-source-summary::before { content:"›"; display:inline-block; flex:0 0 auto; transition:transform .15s; }
        .hp-source-details[open] > .hp-source-summary::before { transform:rotate(90deg); }
        .hp-source-summary:hover { color:var(--hp-text-strong); }
        .hp-source-details.hp-orphan-disabled > .hp-source-summary { opacity:.55; cursor:default; }
        .hp-node-message-viewer { margin-top:7px; }
        .hp-node-footer + .hp-node-message-viewer { width:100%; }
        .hp-prompt-field { box-sizing:border-box; display:block; width:100%; margin-left: auto; margin-right:auto; }
        .hp-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:6px 0; }
        .hp-row[hidden] { display:none; }
        .hp-label { font-size:var(--hp-ui-font); font-weight:bold; min-width:120px; }
        .hp-field { display:flex; flex-direction:column; gap:5px; min-width:0; }
        .hp-field-label { color:var(--hp-text-strong); font-size:var(--hp-ui-font-small); font-weight:bold; line-height:1.3; }
        .hp-field-hint { color:var(--hp-text-muted); font-size:var(--hp-ui-font-meta); font-weight:normal; }
        .hp-date-parser { margin-bottom:12px; }
        .hp-date-parser > summary { display:flex; align-items:center; gap:7px; cursor:pointer; color:var(--hp-text-strong); font-size:var(--hp-ui-font); font-weight:bold; list-style-position:outside; }
        .hp-date-parser-scope { color:var(--hp-text-muted); font-size:var(--hp-ui-font-meta); font-weight:normal; }
        .hp-date-parser-current { margin-left:auto; color:var(--hp-text); font-size:var(--hp-ui-font-small); }
        .hp-date-parser-grid { display:grid; grid-template-columns:minmax(88px,.55fr) minmax(150px,.9fr) minmax(180px,1.4fr) auto; align-items:end; gap:12px; margin-top:12px; }
        .hp-date-parser-pattern { grid-column:1 / -1; }
        .hp-date-parser-preview { align-self:stretch; display:flex; align-items:center; gap:8px; min-width:0; padding:6px 9px; border:var(--hp-border-width) solid var(--hp-border); border-radius:var(--hp-radius-sm); background:var(--hp-inset); }
        .hp-date-parser-preview[hidden] { display:none; }
        .hp-date-parser-preview strong { flex:0 0 auto; color:var(--hp-text-strong); font-size:var(--hp-ui-font-small); }
        .hp-date-parser-preview-source { min-width:0; overflow:hidden; color:var(--hp-text-muted); font-size:var(--hp-ui-font-meta); text-overflow:ellipsis; white-space:nowrap; }
        .hp-date-parser-action { grid-column:4; align-self:end; }
        .hp-regex-panel-intro { margin:0; color:var(--hp-text-muted); font-size:var(--hp-ui-font-small); line-height:1.5; }
        .hp-regex-stack { margin:8px 0; }
        .hp-regex-stack .hp-regex-rule { margin:0; border-radius:0; }
        .hp-regex-stack .hp-regex-rule + .hp-regex-rule { border-top:0; }
        .hp-regex-stack .hp-regex-rule:first-child { border-top-left-radius:var(--hp-radius-card); border-top-right-radius:var(--hp-radius-card); }
        .hp-regex-stack .hp-regex-rule:last-child { border-bottom-left-radius:var(--hp-radius-card); border-bottom-right-radius:var(--hp-radius-card); }
        .hp-regex-toolbar { display:flex; align-items:center; gap:7px; flex-wrap:wrap; }
        .hp-regex-count { margin-left:auto; color:var(--hp-text-muted); font-size:var(--hp-ui-font-small); white-space:nowrap; }
        .hp-regex-rule { display:grid; gap:12px; padding:14px; }
        .hp-regex-rule-summary { display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:8px; min-width:0; }
        .hp-regex-header-enabled { display:inline-flex; align-items:center; justify-content:center; margin:0; cursor:pointer; }
        .hp-regex-header-enabled input { margin:0; }
        .hp-regex-open { min-width:0; padding:2px 0; overflow:hidden; border:0; background:transparent; color:var(--hp-text-strong); font:inherit; font-weight:bold; text-align:left; text-overflow:ellipsis; white-space:nowrap; cursor:pointer; }
        .hp-regex-open::before { content:"›"; display:inline-block; margin-right:6px; color:var(--hp-text-control); transition:transform .15s; }
        .hp-regex-open[aria-expanded="true"]::before { transform:rotate(90deg); }
        .hp-regex-delete-rule { display:inline-flex; align-items:center; justify-content:center; width:28px; height:28px; padding:0; border:0; background:transparent; color:var(--hp-danger); cursor:pointer; }
        .hp-regex-delete-rule:hover { color:var(--hp-danger-hover); }
        .hp-regex-delete-rule .material-symbols-outlined { font-size:20px; }
        .hp-regex-rule-header { display:flex; align-items:center; justify-content:flex-end; gap:10px; }
        .hp-regex-scope-options { display:flex; align-items:center; gap:6px 12px; flex-wrap:wrap; }
        .hp-regex-check { display:inline-flex; align-items:center; gap:5px; color:var(--hp-text); font-size:var(--hp-ui-font-small); white-space:nowrap; cursor:pointer; }
        .hp-regex-check input { margin:0; }
        .hp-regex-io-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; min-width:0; }
        .hp-regex-io-grid .hp-textarea { display:block; height:96px; resize:vertical; }
        .hp-regex-rule-footer { display:grid; grid-template-columns:minmax(0,1fr) minmax(72px,92px) auto; align-items:end; gap:10px; padding-top:11px; border-top:var(--hp-border-width) solid var(--hp-border); }
        .hp-regex-targets { display:flex; align-items:center; gap:6px 14px; flex-wrap:wrap; min-width:0; }
        .hp-regex-targets-title { color:var(--hp-text-strong); font-size:var(--hp-ui-font-small); font-weight:bold; }
        .hp-regex-actions { display:flex; justify-content:flex-end; gap:6px; }
        .hp-proto-heading { display:flex; align-items:center; gap:6px; flex-wrap:wrap; min-width:0; }
        .hp-proto-id { display:inline-flex; align-items:center; color:var(--hp-text-muted); font-size:var(--hp-ui-font-meta); font-weight:400; line-height:1; }
        .hp-proto-time { display:inline-block; flex:0 1 auto; min-width:0; max-width:100%; overflow:hidden; color:var(--hp-text); text-overflow:clip; white-space:nowrap; }
        .hp-proto-age { color:var(--hp-primary); font-size:11px; font-weight:600; }
        .hp-proto-chip { display:inline-flex; align-items:center; max-width:180px; padding:2px 7px; border:var(--hp-border-width) solid var(--hp-border); border-radius:var(--hp-radius-pill); font-size:11px; line-height:1.4; color:var(--hp-text); background:var(--hp-inset); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .hp-proto-tag { opacity:.9; }
        .hp-proto-category { font-weight:bold; }
        .hp-proto-source-row { display:flex; align-items:center; gap:7px; flex-wrap:wrap; margin-top:9px; padding-top:8px; border-top:var(--hp-border-width) solid var(--hp-border); }
        .hp-node-footer { justify-content:space-between; flex-wrap:nowrap; width:100%; min-width:0; }
        .hp-node-footer-source { display:flex; align-items:center; gap:7px; flex:1 1 auto; min-width:0; flex-wrap:wrap; }
        .hp-node-footer-actions { display:inline-flex; align-items:center; justify-content:flex-end; gap:3px; flex:0 0 auto; margin-left:auto; }
        .hp-proto-source-label { color:var(--hp-text-muted); font-size:11px; }

        .hp-pagination { display:flex; gap:4px; justify-content:center; margin:12px 0; }
        .hp-empty { color:var(--hp-text-muted); text-align:center; padding:40px; font-size:14px; }
        .hp-edit-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.85); display:flex; align-items:center; justify-content:center; z-index:100; color:var(--hp-text); }
        .hp-edit-box { background:var(--hp-background); border:var(--hp-border-width) solid var(--hp-border); border-radius:var(--hp-radius-modal); padding:20px; width:90%; max-width:650px; max-height:90vh; overflow-y:auto; color:var(--hp-text); }
        .hp-edit-box h3 { margin-top:0; color:var(--hp-text-strong); }
        .hp-edit-box pre { color:var(--hp-text-control); background:var(--hp-inset) !important; }
        .hp-edit-box pre.hp-message-view-content { color:var(--hp-text); }
        .hp-trace-box { box-sizing:border-box; width:min(94vw,920px); max-width:920px; padding:14px; }
        .hp-trace-header { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:10px; }
        .hp-trace-header h3 { min-width:0; margin:0; font-size:16px; }
        .hp-trace-summary { margin-bottom:12px; padding:9px; border:var(--hp-border-width) solid var(--hp-border); border-radius:var(--hp-radius-sm); background:var(--hp-inset); font-size:12px; line-height:1.55; }
        .hp-trace-section-title { margin:14px 0 7px; color:var(--hp-text-strong); font-size:var(--hp-ui-font); }
        .hp-trace-card { margin:6px 0; padding:8px; border:var(--hp-border-width) solid var(--hp-border); border-radius:var(--hp-radius-sm); background:var(--hp-surface); }
        .hp-trace-card-head { display:flex; align-items:center; justify-content:space-between; gap:8px; color:var(--hp-text-strong); font-size:11px; font-weight:bold; }
        .hp-trace-text { box-sizing:border-box; max-height:160px; margin:6px 0 0; padding:7px; overflow:auto; border-radius:var(--hp-radius-xs); background:var(--hp-inset); color:var(--hp-text); font:inherit; font-size:11px; line-height:1.45; white-space:pre-wrap; overflow-wrap:anywhere; }
        .hp-trace-score-row { display:grid; grid-template-columns:minmax(82px,auto) 1fr auto; gap:7px; align-items:start; padding:4px 0; border-bottom:var(--hp-border-width) solid var(--hp-border); font-size:11px; }
        .hp-trace-score-row:last-child { border-bottom:0; }
        .hp-trace-score-query { color:var(--hp-text-strong); }
        .hp-trace-score-text { min-width:0; overflow:hidden; color:var(--hp-text-muted); text-overflow:ellipsis; white-space:nowrap; }
        .hp-trace-formula { margin-top:7px; color:var(--hp-text-control); font-size:11px; overflow-wrap:anywhere; }
        @media (max-width:600px) {
          .hp-trace-box { width:96vw; max-height:94vh; padding:10px; }
          .hp-trace-score-row { grid-template-columns:1fr auto; }
          .hp-trace-score-text { grid-column:1 / -1; white-space:normal; }
        }
        .hp-edit-box .hp-row { margin:8px 0; }
        .hp-edit-box .hp-label { min-width:80px; }
        .hp-edit-box .hp-meta-row { flex-wrap:nowrap; }
        .hp-edit-box .hp-meta-row .hp-input { width:auto; min-width:0; flex:1 1 0; }
        .hp-node-edit-box { box-sizing:border-box; display:flex; flex-direction:column; width:90%; max-width:900px; height:90vh; max-height:90vh; overflow:hidden; }
        .hp-node-edit-box.hp-node-create-box { width:min(680px,calc(100vw - 32px)); height:65vh; max-height:65vh; margin:auto; overflow:hidden; }
        .hp-node-editor-header { display:grid; grid-template-columns:80px minmax(92px,110px) minmax(160px,1fr); align-items:center; gap:8px; flex:0 0 auto; margin-bottom:8px; }
        .hp-node-editor-header h3 { min-width:0; margin:0; white-space:nowrap; }
        .hp-node-editor-header .hp-select, .hp-node-editor-header .hp-input { box-sizing:border-box; width:100%; min-width:0; }
        .hp-node-editor-header .hp-input { font-weight:bold; }
        .hp-node-edit-titlebar { display:flex; align-items:center; width:100%; margin-bottom:7px; }
        .hp-node-editor-time-title { appearance:none; box-sizing:border-box; width:100%; min-width:0; padding:1px 2px 5px; border:0; border-bottom:var(--hp-border-width-subtle) solid transparent; border-radius:0; outline:none; background:transparent; color:var(--hp-text-strong); font:inherit; font-size:20px; font-weight:700; line-height:1.2; }
        .hp-node-editor-time-title:hover { border-bottom-color:var(--hp-border); }
        .hp-node-editor-time-title:focus { border-bottom-color:var(--hp-primary); background:var(--hp-inset); }
        .hp-node-create-header { display:flex; align-items:center; gap:8px; }
        .hp-node-create-header h3 { display:flex; align-items:baseline; gap:5px; flex:0 0 auto; white-space:normal; font-size:18px; line-height:1.15; }
        .hp-node-create-number { color:var(--hp-text-muted); font-size:var(--hp-ui-font-small); font-weight:400; }
        .hp-node-create-header .hp-node-editor-time-title { flex:1 1 auto; width:auto; font-size:22px; }
        .hp-node-create-actions { display:flex; align-items:center; gap:3px; width:100%; min-width:0; margin:2px 0 3px; }
        .hp-node-create-actions .hp-node-tag-strip { min-height:32px; }
        .hp-node-create-links { margin-top:7px; }
        .hp-node-create-links .hp-input { box-sizing:border-box; width:100%; max-width:none; }
        .hp-node-create-description { flex:0 0 auto; margin:0 0 6px; color:var(--hp-text-muted); font-size:var(--hp-ui-font-small); }
        .hp-node-edit-form { display:flex; flex:1 1 auto; flex-direction:column; min-height:0; }
        .hp-node-content-row { display:flex; flex-direction:column; align-items:stretch; flex-wrap:nowrap; min-height:180px; }
        .hp-node-content-toolbar { display:flex; align-items:center; gap:5px; flex-wrap:wrap; width:100%; margin-bottom:5px; }
        .hp-editor-tool { padding:4px 8px; }
        .hp-node-content-editor { box-sizing:border-box; flex:1 1 auto; min-height:180px; resize:none; font-family:var(--hp-reading-font); font-size:var(--hp-reading-body); line-height:1.6; }
        .hp-node-find-bar .hp-input { box-sizing:border-box; min-width:0; padding:5px 7px; }
        .hp-node-editor-indexes { position:relative; z-index:2; display:flex; align-items:flex-end; gap:3px; flex:0 0 auto; margin:0 0 -1px; padding:0; }
        .hp-node-editor-mode { appearance:none; min-width:78px; padding:6px 12px; border:var(--hp-border-width) solid var(--hp-border); border-bottom-color:var(--hp-border); border-radius:var(--hp-radius-sm) var(--hp-radius-sm) 0 0; background:var(--hp-secondary); color:var(--hp-text-muted); cursor:pointer; font-size:var(--hp-ui-font-small); text-align:center; }
        .hp-node-editor-compare-group { display:inline-flex; align-items:flex-end; gap:5px; margin-left:auto; }
        .hp-node-editor-mode.active { border-bottom-color:var(--hp-inset); background:var(--hp-inset); color:var(--hp-text-strong); font-weight:bold; }
        .hp-node-editor-mode:disabled { opacity:.45; cursor:default; }
        .hp-node-editor-status { align-self:center; color:var(--hp-danger); font-size:var(--hp-ui-font-meta); white-space:nowrap; }
        .hp-toggle { position:relative; display:inline-block; width:44px; height:24px; }
        .hp-toggle input { opacity:0; width:0; height:0; }
        .hp-toggle .slider { position:absolute; cursor:pointer; inset:0; background:var(--hp-secondary); border-radius:var(--hp-radius-pill); transition:.2s; }
        .hp-toggle .slider:before { content:""; position:absolute; height:18px; width:18px; left:3px; bottom:3px; background:var(--hp-text-on-color); border-radius:var(--hp-radius-circle); transition:.2s; }
        .hp-toggle input:checked+.slider { background:var(--hp-primary); }
        .hp-toggle input:checked+.slider:before { transform:translateX(20px); }
        .hp-wrap pre, .hp-wrap code { background-color:var(--hp-inset) !important; }
        .hp-fav-node { appearance:none; box-sizing:border-box; display:inline-flex; align-items:center; justify-content:center; width:26px; height:26px; border:none; background:none; color:var(--hp-text-muted); cursor:pointer; line-height:1; margin:0; padding:3px; }
        .hp-fav-node .material-symbols-outlined { font-size:20px; font-variation-settings:"FILL" 0,"wght" 400,"GRAD" 0,"opsz" 24; }
        .hp-fav-node[data-favorite="true"] .material-symbols-outlined { font-variation-settings:"FILL" 1,"wght" 400,"GRAD" 0,"opsz" 24; }
        .hp-fav-node[data-favorite="true"], .hp-fav-node:hover { color:var(--hp-favorite); }
        .hp-node-menu-wrap { position:relative; display:inline-flex; align-items:center; }
        .hp-node-menu-button { appearance:none; width:26px; height:26px; margin:0; padding:2px; border:none; background:none; color:var(--hp-text-muted); cursor:pointer; }
        .hp-node-menu-button:hover { color:var(--hp-text-strong); }
        .hp-node-menu-popover { position:absolute; z-index:35; right:0; top:calc(100% + 6px); display:flex; flex-direction:column; gap:2px; padding:5px; border:0; border-radius:9px; background:var(--hp-panel); box-shadow:0 8px 24px rgba(0,0,0,.22); }
        .hp-node-menu-popover[hidden] { display:none !important; }
        .hp-node-menu-item { appearance:none; width:30px; height:30px; padding:3px; border:0; border-radius:7px; background:transparent; color:var(--hp-text); cursor:pointer; display:inline-flex; align-items:center; justify-content:center; }
        .hp-node-menu-item:hover { background:var(--hp-secondary-hover); color:var(--hp-primary); }
        .hp-card-inline-editor { margin:0; }
        .hp-card-inline-editor.hp-node-translation { margin:0 -12px -12px; }
        .hp-card-inline-content { box-sizing:border-box; width:100%; min-height:1.6em; border:var(--hp-border-width-subtle) solid color-mix(in srgb,var(--hp-border) 70%,transparent); border-radius:var(--hp-radius-xs); background:transparent; outline:none; }
        .hp-card-inline-content { margin:6px 0; padding:3px 5px; font-family:var(--hp-reading-font); font-size:var(--hp-reading-body); line-height:1.6; white-space:pre-wrap; }
        .hp-card-inline-content:focus { border-color:var(--hp-primary); }
        .hp-card-inline-time { appearance:none; box-sizing:border-box; flex:1 1 auto; min-width:0; max-width:100%; padding:1px 2px; border:0; border-bottom:var(--hp-border-width-subtle) solid transparent; background:transparent; color:var(--hp-text); font:inherit; font-weight:bold; outline:none; }
        .hp-card-inline-time:hover, .hp-card-inline-time:focus { border-bottom-color:var(--hp-border); }
        .hp-card-inline-meta { display:grid; grid-template-columns:minmax(0,1fr); gap:6px; margin:6px 0 8px; }
        .hp-card-inline-meta-field { min-width:0; }
        .hp-card-inline-meta-field .hp-field-label { display:block; margin-bottom:3px; font-size:var(--hp-ui-font-meta); color:var(--hp-text-muted); }
        .hp-card-inline-meta-input { box-sizing:border-box; width:100%; min-width:0; padding:5px 7px; border:var(--hp-border-width-subtle) solid color-mix(in srgb,var(--hp-border) 70%,transparent); border-radius:var(--hp-radius-xs); background:transparent; color:var(--hp-text); outline:none; }
        .hp-card-inline-meta-input:focus { border-color:var(--hp-primary); }
        @media (max-width:640px) { .hp-card-inline-meta { grid-template-columns:1fr; } }
        .hp-card-inline-history { display:inline-flex; align-items:center; gap:4px; margin-right:4px; }
        .hp-history-icon-btn { box-sizing:border-box; display:inline-flex; align-items:center; justify-content:center; inline-size:28px; block-size:28px; padding:5px; }
        .hp-history-icon-btn svg { display:block; inline-size:18px; block-size:18px; flex:0 0 auto; }
        .hp-inline-save-status { position:fixed; z-index:140; left:50%; bottom:18px; transform:translateX(-50%); padding:7px 13px; border:var(--hp-border-width) solid var(--hp-border); border-radius:999px; background:var(--hp-surface); color:var(--hp-text-strong); box-shadow:0 5px 18px rgba(0,0,0,.24); font-size:var(--hp-ui-font-small); pointer-events:none; }
        .hp-inline-save-status[hidden] { display:none; }
        .hp-summary-preview-card { opacity:.72; }
        .hp-like-node { position:relative; appearance:none; box-sizing:border-box; width:26px; height:26px; margin:0; padding:3px; border:none; background:none; color:var(--hp-text-muted); cursor:pointer; }
        .hp-like-node[data-liked="true"] { color:var(--hp-favorite); }
        .hp-like-node:hover { color:var(--hp-favorite); }
        .hp-like-icon { position:absolute; inset:3px; display:block; font-size:20px; line-height:20px; }
        .hp-like-outline { font-variation-settings:"FILL" 0,"wght" 400,"GRAD" 0,"opsz" 24; }
        .hp-like-fill { color:var(--hp-favorite); font-variation-settings:"FILL" 1,"wght" 400,"GRAD" 0,"opsz" 24; clip-path:inset(var(--hp-like-empty,100%) 0 0 0); }
        @media (max-width:768px) {
          body { align-items:stretch; justify-content:stretch; }
          .hp-tabs { gap:3px; min-height:36px; padding:2px 4px; }
          .hp-memory-subbar { top:36px; gap:3px; min-height:36px; padding:3px 4px; }
          .hp-memory-edit-toggle { flex-basis:105px; width:105px; padding-left:7px; padding-right:7px; }
          .hp-memory-subbar .hp-chosen-stat-toggle { padding:5px 6px; font-size:var(--hp-ui-font-small); }
          .hp-settings-workspace { --hp-settings-label-column:minmax(0,40%); --hp-settings-control-column:minmax(0,60%); --hp-settings-compact-control-width:46%; }
          .hp-row.hp-settings-form-row { grid-template-columns:var(--hp-settings-label-column) var(--hp-settings-control-column); row-gap:5px; column-gap:10px; align-items:center; margin:9px 0; }
          .hp-settings-form-row > .hp-label { grid-column:1; grid-row:1; }
          .hp-settings-form-row > .hp-input,
          .hp-settings-form-row > .hp-select,
          .hp-settings-form-row > .hp-toggle { grid-column:2; grid-row:1; }
          .hp-settings-form-row > .hp-settings-row-hint { grid-column:2; grid-row:2; }
          .hp-settings-form-row > .hp-input,
          .hp-settings-form-row > .hp-select { width:100% !important; max-width:none; }
          .hp-settings-form-row.hp-settings-form-row-compact > .hp-input,
          .hp-settings-form-row.hp-settings-form-row-compact > .hp-select { width:var(--hp-settings-compact-control-width) !important; max-width:none; }
          .hp-settings-form-row.hp-settings-form-row-mobile-stack { grid-template-columns:minmax(0,1fr); row-gap:5px; column-gap:0; align-items:start; }
          .hp-settings-form-row.hp-settings-form-row-mobile-stack > .hp-label { grid-column:1; grid-row:1; }
          .hp-settings-form-row.hp-settings-form-row-mobile-stack > .hp-input,
          .hp-settings-form-row.hp-settings-form-row-mobile-stack > .hp-select { grid-column:1; grid-row:2; width:100% !important; max-width:none; justify-self:stretch; }
          .hp-settings-form-row.hp-settings-form-row-mobile-stack > .hp-settings-row-hint { grid-column:1; grid-row:3; }
          .hp-settings-workspace .hp-input,
          .hp-settings-workspace .hp-select { padding:4px 8px; }
          .hp-main-nav-button { min-height:28px; max-width:112px; padding:2px 5px; }
          .hp-ui-menu-button { min-height:28px; padding:2px 7px; }
          .hp-data-menu-button { min-width:82px; }
          .hp-ui-menu-item { min-height:44px; }
          .hp-ui-menu-current, .hp-ui-menu-root .hp-theme-swatches { display:none; }
          .hp-close-btn { flex-basis:29px; width:29px; height:28px; margin:0; }
          .hp-content, .hp-node-translation-content, .hp-node-content-editor { line-height:1.5; }
          .hp-content .dl-line { line-height:1.45; }
          .hp-node-primary-row { overflow:hidden; }
          .hp-node-primary-row .hp-node-heading { flex:1 1 0; flex-wrap:nowrap; overflow:hidden; }
          .hp-node-primary-row .hp-proto-time { flex:1 1 auto; min-width:0; max-width:none; overflow:hidden; white-space:nowrap; text-overflow:clip; }
          .hp-node-primary-row .hp-node-id-group,
          .hp-node-primary-row .hp-proto-age,
          .hp-node-primary-row .hp-node-status-slot { flex:0 0 auto; margin-left:auto; }
          .hp-node-footer-source { flex-wrap:nowrap; overflow:hidden; }
          .hp-node-footer-source .hp-proto-source-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
          .hp-wrap { width:100vw; height:100vh; height:100dvh; max-width:none; max-height:none; border:none; border-radius:0; box-shadow:none; }
          .hp-node-edit-overlay { align-items:stretch; justify-content:stretch; }
          .hp-node-edit-box { display:flex; flex-direction:column; width:100vw; height:100vh; height:100dvh; max-width:none; max-height:none; padding:12px; border:none; border-radius:0; overflow:hidden; }
          .hp-node-edit-overlay .hp-node-create-box { align-self:center; width:calc(100vw - 24px); height:65dvh; max-height:65dvh; margin:auto; padding:14px; border:var(--hp-border-width) solid var(--hp-border); border-radius:var(--hp-radius-modal); overflow:hidden; }
          .hp-node-editor-header { grid-template-columns:80px minmax(82px,100px) minmax(0,1fr); gap:8px; margin-bottom:4px; }
          .hp-node-editor-header h3 { font-size:18px; }
          .hp-node-create-header { gap:6px; }
          .hp-node-create-header h3 { font-size:var(--hp-ui-font); }
          .hp-node-create-header .hp-node-editor-time-title { font-size:19px; }
          .hp-node-create-box .hp-node-content-row { flex:0 0 auto; min-height:180px; }
          .hp-node-create-box .hp-node-content-editor { min-height:180px; resize:vertical; }
          .hp-node-editor-header .hp-select, .hp-node-editor-header .hp-input { padding:6px 8px; }
          .hp-node-edit-form { flex:1 1 auto; }
          .hp-node-content-row { flex:1 1 auto; min-height:120px; }
          .hp-node-content-editor { min-height:120px; }
          .hp-node-edit-box .hp-row { margin:5px 0; }
          .hp-node-editor-mode { min-width:68px; padding:6px 9px; }
          .hp-date-parser-grid { grid-template-columns:minmax(80px,.55fr) minmax(132px,.85fr) minmax(0,1fr); gap:10px; }
          .hp-date-parser-action { grid-column:3; }
          .hp-regex-rule-footer { grid-template-columns:minmax(0,1fr) minmax(72px,88px); }
          .hp-regex-actions { grid-column:1 / -1; }
        }
        @media (max-width:520px) {
          .hp-body { padding:10px; }
          .hp-settings-workspace { --hp-settings-label-column:minmax(0,42%); --hp-settings-control-column:minmax(0,58%); --hp-settings-compact-control-width:48%; }
          .hp-date-parser { padding:11px; }
          .hp-date-parser-grid { grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:10px 8px; }
          .hp-date-parser-pattern, .hp-date-parser-preview, .hp-date-parser-action { grid-column:1 / -1; }
          .hp-date-parser-action .hp-btn { width:100%; }
          .hp-date-parser-preview { align-items:flex-start; flex-direction:column; gap:2px; }
          .hp-date-parser-preview-source { max-width:100%; white-space:normal; overflow-wrap:anywhere; }
          .hp-regex-toolbar { align-items:stretch; }
          .hp-regex-toolbar .hp-btn { flex:1 1 calc(50% - 4px); }
          .hp-regex-count { flex:1 0 100%; margin-left:0; text-align:right; }
          .hp-regex-rule { gap:10px; padding:11px; }
          .hp-regex-io-grid, .hp-regex-rule-footer { grid-template-columns:1fr; }
          .hp-regex-scope-options { gap:8px 12px; }
          .hp-regex-rule-header { justify-content:flex-start; }
          .hp-regex-actions { grid-column:auto; }
          .hp-regex-io-grid .hp-textarea { height:84px; }
          .hp-regex-flags-field { max-width:92px; }
          .hp-regex-actions .hp-btn { flex:1 1 0; }
        }
      </style>
      <div class="hp-wrap">
        <div class="hp-tabs" data-version-label="${DISTRIBUTION_VERSION_LABEL}">
          <div class="hp-main-nav" id="hp-main-nav">
            <button class="hp-main-nav-button${activeTab === "settings" ? " active" : ""}" id="hp-nav-settings" type="button" aria-pressed="${activeTab === "settings"}">설정</button>
            <span class="hp-main-nav-separator" aria-hidden="true">|</span>
            <button class="hp-main-nav-button${activeTab === "lorebook" ? " active" : ""}" id="hp-nav-lorebook" type="button" aria-pressed="${activeTab === "lorebook"}">로어북</button>
            <span class="hp-main-nav-separator" aria-hidden="true">|</span>
          </div>
          <div class="hp-toolbar-ui">${renderUiMenu()}</div>
          <div class="hp-toolbar-ui">${renderDataManagementMenu()}</div>
          <div class="hp-toolbar-ui">${renderToolsMenu()}</div>
          <span class="hp-topbar-spacer" aria-hidden="true"></span>
          <button class="hp-close-btn" id="hp-close" type="button" title="닫기" aria-label="닫기"><span class="material-symbols-outlined" aria-hidden="true">close</span></button>
        </div>
        ${activeTab === "nodes" ? renderMemorySubbar() : ""}
        <div class="hp-body" id="hp-body">
          ${renderNodesPanel(pendingMessages, charName, chatName)}
          ${renderSettingsWorkspace()}
          ${renderLorebookWorkspace()}
        </div>
      </div>
      <div class="hp-inline-save-status" id="hp-inline-save-status" hidden>저장 중…</div>
      ${showSummarizeDialog ? renderSummarizeDialog(pendingMessages) : ""}
      ${showCreateNodeDialog ? renderCreateNodeOverlay() : ""}
    `;
        attachSettingsHelpEvents();
        attachUIEvents(pendingMessages);
        showInlineSaveStatus(inlineSaveStatus);
        if (restoreScrollTop !== null) {
            requestAnimationFrame(() => {
                const body = document.getElementById("hp-body");
                if (body)
                    body.scrollTop = restoreScrollTop;
            });
        }
    }
    // ── Panel: Nodes ─────────────────────────────────────────────────────────
    function renderMemorySubbar() {
        const allNodes = getNodes();
        const chosenNodeIds = new Set(state.lastChosenNodeIds ?? []);
        const recentNodeIds = new Set(state.lastRecentNodeIds ?? []);
        const chosenCount = allNodes.filter(node => chosenNodeIds.has(node.id)).length;
        const recentCount = allNodes.filter(node => recentNodeIds.has(node.id)).length;
        return `<div class="hp-memory-subbar">
      <button class="hp-btn secondary has-icon hp-memory-edit-toggle${cardInlineEditMode ? " active" : ""}" id="hp-toggle-card-edit-mode" type="button" aria-pressed="${cardInlineEditMode}"><span class="material-symbols-outlined" aria-hidden="true">edit</span><span>${cardInlineEditMode ? "편집 종료" : "편집 모드"}</span></button>
      ${cardInlineEditMode ? `<span class="hp-card-inline-history"><button class="hp-btn secondary small icon-only hp-history-icon-btn hp-memory-undo" type="button" aria-label="실행 취소" title="실행 취소"><svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path d="M18 13C17.4904 11.9961 16.6247 11.1655 15.5334 10.6333C14.442 10.1011 13.1842 9.89624 11.9494 10.0495C9.93127 10.3 8.52468 11.6116 7 12.8186M7 10V13H10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button><button class="hp-btn secondary small icon-only hp-history-icon-btn hp-memory-redo" type="button" aria-label="재실행" title="재실행"><svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path d="M6 13C6.50963 11.9961 7.37532 11.1655 8.46665 10.6333C9.55797 10.1011 10.8158 9.89624 12.0506 10.0495C14.0687 10.3 15.4753 11.6116 17 12.8186M17 10V13H14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button></span>` : ""}

      <button type="button" class="hp-stat hp-chosen-stat-toggle${showChosenNodesOnly ? " hp-chosen-stat-active" : ""}" id="hp-chosen-stat-toggle" aria-pressed="${showChosenNodesOnly}" title="현재 컨텍스트에 들어간 유사 메모리와 최근 메모리를 모아봅니다."><span class="material-symbols-outlined hp-status-check" aria-hidden="true">check_circle</span><span>유사 <b>${chosenCount}</b>개 +</span><span class="material-symbols-outlined hp-status-bolt" aria-hidden="true">bolt</span><span>최근 <b>${recentCount}</b>개</span></button>
      <span class="hp-memory-subbar-spacer" aria-hidden="true"></span>
      <button class="hp-search-toggle" id="hp-search-toggle" type="button" title="기억 검색" aria-label="기억 검색" aria-expanded="${nodeSearchOpen}">🔍</button>
      <div class="hp-search-overlay" id="hp-search-overlay" ${nodeSearchOpen ? "" : "hidden"}>
        <input class="hp-input" type="text" id="hp-node-search" placeholder="기억 검색 (내용, 시간, 카테고리, 태그)..." value="${escapeHtml(nodeSearchDraft)}">
        <button class="hp-btn primary small" id="hp-node-search-submit" type="button">검색</button>
        ${nodeSearchQuery ? `<button class="hp-btn secondary small" id="hp-node-search-clear">초기화</button>` : ""}
      </div>
    </div>`;
    }
    function renderNodesPanel(pendingMessages, charName, chatName) {
        const allNodes = getNodes();
        // Sort before filtering/pagination using the shared priority:
        // parsed time -> resolved linked-message index -> createdAt.
        const sortedNodes = nodeSortDirection === "tokens-desc"
            ? allNodes.map(node => ({ node, tokens: estimateNodeTokens(node) }))
                .sort((a, b) => b.tokens - a.tokens).map(item => item.node)
            : sortNodesByTime(allNodes, nodeSortDirection);
        // Filter populated entries by their memory fields.
        const normalizedNodeQuery = nodeSearchQuery.toLowerCase();
        const isEditedNodeRevealTarget = (node) => false;
        const searchMatchedNodes = nodeSearchQuery
            ? sortedNodes.filter((n) => {
                const q = normalizedNodeQuery;
                return (n.content.toLowerCase().includes(q) ||
                    n.time.toLowerCase().includes(q) ||
                    (n.category?.toLowerCase().includes(q) ?? false) ||
                    (n.tags ?? []).some((tag) => tag.toLowerCase().includes(q)) ||
                    isEditedNodeRevealTarget(n));
            })
            : sortedNodes;
        // Use the exact same IDs as the existing context-included badge.
        const chosenNodeIds = new Set(state.lastChosenNodeIds ?? []);
        // Keep the badges tied to the last completed retrieval, including after the UI is reopened.
        const recentNodeIds = new Set(state.lastRecentNodeIds ?? []);
        const filteredNodes = showChosenNodesOnly
            ? searchMatchedNodes.filter((n) => chosenNodeIds.has(n.id) ||
                recentNodeIds.has(n.id) ||
                isEditedNodeRevealTarget(n))
            : searchMatchedNodes;
        const entriesForDisplay = summarizationPreviewEntry ? [...state.entries, summarizationPreviewEntry] : state.entries;
        const emptyEntries = sortEntriesByMessageIndex(entriesForDisplay.filter(entry => entry.memory === null)
            .filter(entry => !normalizedNodeQuery && (!showChosenNodesOnly || entry === summarizationPreviewEntry)), nodeSortDirection === "desc" ? "desc" : "asc");
        // Keep the selected date order as the primary order, but pull memories from the same
        // linked-message set together as a UI-only stack at the first matching position.
        const groupedMemoryBuckets = new Map();
        const groupedMemoryKeys = [];
        for (const node of filteredNodes) {
            const key = nodeSortDirection === "tokens-desc" ? `memory:${node.id}` : memoryLinkKey(node) || `memory:${node.id}`;
            let bucket = groupedMemoryBuckets.get(key);
            if (!bucket) {
                bucket = [];
                groupedMemoryBuckets.set(key, bucket);
                groupedMemoryKeys.push(key);
            }
            bucket.push(node);
        }
        const memoryDisplayGroups = groupedMemoryKeys.map((key) => groupedMemoryBuckets.get(key) ?? []);
        // Paginate whole MemoryEntry stacks rather than cutting a connected stack between pages.
        // A page may exceed the selected count only when one MemoryEntry itself is larger.
        const memoryPages = [];
        let currentMemoryPage = [];
        for (const displayGroup of memoryDisplayGroups) {
            if (currentMemoryPage.length > 0 &&
                currentMemoryPage.length + displayGroup.length > nodesPerPage) {
                memoryPages.push(currentMemoryPage);
                currentMemoryPage = [];
            }
            currentMemoryPage.push(...displayGroup);
        }
        if (currentMemoryPage.length > 0)
            memoryPages.push(currentMemoryPage);
        if (memoryPages.length === 0)
            memoryPages.push([]);
        // Empty entries are a single disclosure section at the absolute end of the list,
        // so they do not consume memory-card pagination slots or appear between memories.
        const totalPages = memoryPages.length;
        if (nodeListPage >= totalPages)
            nodeListPage = totalPages - 1;
        const pageItems = memoryPages[nodeListPage] ?? [];
        const showEmptyEntriesOnThisPage = emptyEntries.length > 0 && nodeListPage === totalPages - 1;
        const usage = state.autoSummaryLastUsage;
        const trackedTokenText = usage
            ? `${Math.round(usage.inputTokens).toLocaleString()}/${Math.round(usage.maxContext).toLocaleString()}`
            : "—/—";
        let pendingPreviewHtml = `<section class="hp-pending-section" style="margin:0 0 12px;">
      <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:6px;font-size:12px;">
        <strong style="color:var(--hp-text-strong);">다음 요약 예정 메세지:</strong>
        <span class="hp-stat" style="margin:0;padding:4px 8px;">미요약 <b>${pendingMessages.length}</b>개</span>
        <span class="hp-stat" style="margin:0;padding:4px 8px;" title="최근 모델 요청에서 추적한 입력 토큰 / 최대 컨텍스트">토큰 <b>${trackedTokenText}</b></span>
      </div>`;
        if (pendingMessages.length > 0) {
            const window = pendingMessages.slice(0, chunkSize);
            const displayPending = includeUserMessages ? window : window.filter((m) => m.role !== "user");
            const msg = displayPending[0];
            if (msg) {
                const pendingIndex = pendingMessages.indexOf(msg);
                const startIndex = getLastSummarizedMsgIndex() + 1;
                const messageIndex = startIndex <= 0 ? pendingIndex - 1 : startIndex + pendingIndex;
                const preview = msg.content.length > 200 ? msg.content.slice(0, 200) + "..." : msg.content;
                pendingPreviewHtml += `<div id="hp-pending-messages" style="background:var(--hp-inset);padding:8px;border-radius:var(--hp-radius-sm);font-size:12px;"><div style="padding:3px 0;"><span style="color:var(--hp-text-strong);">[${messageIndex}]</span> ${escapeHtml(preview)}</div></div>`;
            }
        }
        if (pendingMessages.length === 0)
            pendingPreviewHtml += `<div style="background:var(--hp-inset);padding:8px;border-radius:var(--hp-radius-sm);color:var(--hp-text-muted);font-size:12px;">현재 대기 중인 메시지가 없습니다.</div>`;
        pendingPreviewHtml += `</section>`;
        let html = `<div class="hp-panel${activeTab === "nodes" ? " active" : ""}" data-panel="nodes">`;
        if (cardInlineEditMode)
            html += `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:12px;">
      <span id="hp-entry-selection-count">${getSelectedMemoryEntries().length}개 선택</span>
      <button class="hp-btn danger small" id="hp-delete-selected-entries" type="button" ${getSelectedMemoryEntries().length ? "" : "disabled"}>선택 삭제</button>
      <button class="hp-btn secondary small" id="hp-merge-selected-entries" type="button" ${getSelectedMemoryEntries().length >= 2 ? "" : "disabled"}>선택 합치기</button>
    </div>`;
        html += pendingPreviewHtml;
        // Stats bar
        html += `<div style="margin-bottom:12px;">
      ${nodeSearchQuery ? `<span class="hp-stat"> 검색 결과 <b>${searchMatchedNodes.length}</b>개</span>` : ""}                  
       
      <span class="hp-stat"> 챗: <b>${escapeHtml(charName)} / ${escapeHtml(chatName)}</b></span></div>`;
        html += `<details class="hp-card hp-date-parser">
      <summary><span>날짜 파싱</span><strong class="hp-date-parser-current">${currentUiTimelineDetection ? escapeHtml(currentUiTimelineDetection.rawDate) : "—"}</strong><span class="hp-date-parser-scope">캐릭터별 설정</span></summary>
      <div class="hp-date-parser-grid">
        <label class="hp-field hp-date-parser-pattern">
          <span class="hp-field-label">날짜 정규식</span>
          <input class="hp-input" id="hp-timeline-date-regex" value="${escapeHtml(currentCharacterTimelineSettings.timelineDateRegex)}" spellcheck="false" ${currentCharId ? "" : "disabled"}>
        </label>
        <label class="hp-field">
          <span class="hp-field-label">Flags</span>
          <input class="hp-input" id="hp-timeline-date-regex-flags" value="${escapeHtml(currentCharacterTimelineSettings.timelineDateRegexFlags)}" spellcheck="false" ${currentCharId ? "" : "disabled"}>
        </label>
        <label class="hp-field">
          <span class="hp-field-label">날짜 캡처 그룹</span>
          <input class="hp-input" type="number" id="hp-timeline-date-capture-group" value="${currentCharacterTimelineSettings.dateCaptureGroup}" min="0" inputmode="numeric" ${currentCharId ? "" : "disabled"}>
        </label>
        <div class="hp-date-parser-action"><button class="hp-btn primary small" id="hp-save-timeline-parser" ${currentCharId ? "" : "disabled"}>저장</button></div>
      </div>
    </details>`;
        // Date sorting and page-size controls. Search lives in the top-bar overlay.
        html += `<div style="margin-bottom:12px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
      <label style="font-size:12px;color:var(--hp-text-muted);display:flex;align-items:center;gap:5px;">
        <span class="material-symbols-outlined" aria-hidden="true">list_arrow</span><span>정렬</span>
        <select class="hp-select" id="hp-node-sort" style="padding:4px 8px;">
          <option value="asc" ${nodeSortDirection === "asc" ? "selected" : ""}>오래된 순</option>
          <option value="desc" ${nodeSortDirection === "desc" ? "selected" : ""}>최신 순</option>
          <option value="tokens-desc" ${nodeSortDirection === "tokens-desc" ? "selected" : ""}>토큰 많은 순</option>
        </select>
      </label>
      <label style="font-size:12px;color:var(--hp-text-muted);display:flex;align-items:center;gap:5px;">
        <span>보기</span>
        <select class="hp-select" id="hp-nodes-per-page" style="padding:4px 8px;">
          <option value="10" ${nodesPerPage === 10 ? "selected" : ""}>10개씩</option>
          <option value="20" ${nodesPerPage === 20 ? "selected" : ""}>20개씩</option>
          <option value="30" ${nodesPerPage === 30 ? "selected" : ""}>30개씩</option>
        </select>
      </label>
      <span style="font-size:12px;color:var(--hp-text-strong);">${allNodes.length}개</span>
      <button class="hp-btn hp-action-manual-node small has-icon" id="hp-create-node"><span class="material-symbols-outlined" aria-hidden="true">note_add</span><span>기억 추가</span></button>
    </div>`;
        if (pageItems.length === 0 && !showEmptyEntriesOnThisPage) {
            const emptyMessage = showChosenNodesOnly
                ? nodeSearchQuery
                    ? "검색 조건과 유사/최근 메모리 필터에 맞는 기억이 없습니다."
                    : "현재 유사 또는 최근 메모리에 포함된 기억이 없습니다."
                : nodeSearchQuery
                    ? "검색 결과가 없습니다."
                    : "아직 기억이나 MemoryEntry이 없습니다.";
            html += `<div class="hp-empty">${emptyMessage}</div>`;
        }
        else {
            for (let index = 0; index < pageItems.length; index += 1) {
                const node = pageItems[index];
                const key = nodeSortDirection === "tokens-desc" ? "" : memoryLinkKey(node);
                const linkedToPrevious = !!key && memoryLinkKey(pageItems[index - 1]) === key;
                const linkedToNext = !!key && memoryLinkKey(pageItems[index + 1]) === key;
                const linkPosition = linkedToPrevious && linkedToNext
                    ? "middle"
                    : linkedToPrevious
                        ? "last"
                        : linkedToNext
                            ? "first"
                            : "single";
                html += renderNodeCard(node, recentNodeIds.has(node.id), linkPosition);
            }
            if (showEmptyEntriesOnThisPage) {
                html += renderEmptyEntriesSection(emptyEntries);
            }
        }
        // Pagination
        if (totalPages > 1) {
            html += `<div class="hp-pagination">
        <button class="hp-btn secondary small" data-page="0" ${nodeListPage === 0 ? "disabled" : ""}>« First</button>
        <button class="hp-btn secondary small" data-page="${nodeListPage - 1}" ${nodeListPage === 0 ? "disabled" : ""}>‹ Prev</button>
        <span style="padding:4px 12px;font-size:13px;">Page ${nodeListPage + 1} / ${totalPages}</span>
        <button class="hp-btn secondary small" data-page="${nodeListPage + 1}" ${nodeListPage >= totalPages - 1 ? "disabled" : ""}>Next ›</button>
        <button class="hp-btn secondary small" data-page="${totalPages - 1}" ${nodeListPage >= totalPages - 1 ? "disabled" : ""}>Last »</button>
      </div>`;
        }
        html += `</div>`;
        return html;
    }
    // Design-refine UI: card state icons -> single Similar/Recent text badge; favorite/like actions moved to the card footer.
    function memoryStateClasses(isChosen, isRecent) {
        return `${isChosen ? " hp-memory-similar" : ""}${isRecent ? " hp-memory-recent" : ""}`;
    }
    function renderNodeStats(node, scores) {
        const tokenEstimate = `<span class="hp-token-estimate" title="${escapeHtml(memoryTokenizerStatusTitle())}">≈ ${estimateNodeTokens(node)}</span>`;
        if (node.favorite) {
            return `
      <div class="hp-node-stats">
        <span class="hp-node-similarity" title="즐겨찾기는 검색 점수와 무관하게 먼저 주입됩니다.">즐겨찾기 · 항상 주입</span>
        ${tokenEstimate}
      </div>`;
        }
        if (!scores) {
            return `
      <div class="hp-node-stats">
        ${tokenEstimate}
      </div>`;
        }
        const embeddingStatus = scores.embeddingStatus ?? "ok";
        const embeddingStatusTitle = {
            ok: "임베딩 코사인 유사도",
            "not-configured": "임베딩 미설정: 실제 유사도 점수 없음. similarity 기여도는 0으로 계산됩니다.",
            "query-failed": "현재 대화 임베딩 생성 실패: 실제 유사도 점수 없음. similarity 기여도는 0으로 계산됩니다.",
            "node-failed": "이 기억의 임베딩 생성 실패: 실제 유사도 점수 없음. similarity 기여도는 0으로 계산됩니다.",
            "empty-node": "임베딩할 기억 텍스트가 비어 있어 실제 유사도 점수가 없습니다. similarity 기여도는 0으로 계산됩니다.",
        };
        const scoreParts = [];
        if (embeddingStatus === "ok") {
            const embeddingModeTitle = `Query Separate 검색 · 쿼리 ${scores.embeddingQueryCount ?? 0}개 · Memory 단일 벡터`;
            scoreParts.push({ kind: "embedding", text: `임베딩 ${scores.similarity.toFixed(2)}`, title: embeddingModeTitle });
        }
        if ((scores.dialogueLocal ?? 0) > 0) {
            scoreParts.push({
                kind: "dialogue",
                text: `대사 ${(scores.dialogueLocal ?? 0).toFixed(2)} (+${(scores.dialogueContribution ?? 0).toFixed(2)})`,
            });
        }
        if ((scores.dialogueEmbeddingContribution ?? 0) > 0) {
            scoreParts.push({ kind: "dialogue", text: `대사임베딩 ${(scores.dialogueEmbedding ?? 0).toFixed(2)} (+${(scores.dialogueEmbeddingContribution ?? 0).toFixed(2)})` });
        }
        if ((scores.activationCueContribution ?? 0) > 0) {
            scoreParts.push({ kind: "bonus", text: `활성키 +${(scores.activationCueContribution ?? 0).toFixed(2)}` });
        }
        if ((scores.likeBonus ?? 0) > 0) {
            scoreParts.push({ kind: "bonus", text: `좋아요 +${(scores.likeBonus ?? 0).toFixed(2)}` });
        }
        const embeddingBreakdown = `Query Separate 검색 · 쿼리 ${scores.embeddingQueryCount ?? 0}개 · Memory 단일 벡터`;
        const breakdown = [scoreParts.map((part) => part.text).join(" · "), embeddingBreakdown]
            .filter(Boolean)
            .join("\n");
        const dialogueMatchTooltip = scores.dialogueMatch
            ? [
                `일치한 과거 대사: ${scores.dialogueMatch.storedSpeaker} — ${scores.dialogueMatch.storedDialogue}`,
                `현재 대사: ${scores.dialogueMatch.currentDialogue}`,
                `일치 방식: ${scores.dialogueMatch.method}`,
                scores.dialogueMatch.sharedNgrams?.length
                    ? `공통 3-word n-gram: ${scores.dialogueMatch.sharedNgrams.join(" / ")}`
                    : "",
            ].filter(Boolean).join("\n")
            : "";
        const summary = debugMode
            ? `${scoreParts.map((part) => {
                if (part.kind === "dialogue" && part.text.startsWith("대사 ")) {
                    return `<span class="hp-node-dialogue-score hp-score-tooltip" tabindex="0" data-tooltip="${escapeHtml(dialogueMatchTooltip)}" title="${escapeHtml(dialogueMatchTooltip)}">${escapeHtml(part.text)}</span>`;
                }
                return `<span${part.title ? ` title="${escapeHtml(part.title)}"` : ""}>${escapeHtml(part.text)}</span>`;
            }).join(`<span class="hp-score-separator"> · </span>`)}${scoreParts.length ? " " : ""}<span class="hp-score-tooltip" tabindex="0" role="button" data-score-node-id="${escapeHtml(node.id)}" data-tooltip="검색 추적 상세 열기" title="검색 추적 상세 열기" style="color:var(--hp-text-strong);">= 합산 ${scores.combined.toFixed(2)}</span>`
            : breakdown
                ? `<span class="hp-score-tooltip" tabindex="0" role="button" data-score-node-id="${escapeHtml(node.id)}" data-tooltip="${escapeHtml(breakdown)}" title="${escapeHtml(breakdown)}">${scores.combined.toFixed(2)}</span>`
                : `<span>${scores.combined.toFixed(2)}</span>`;
        return `
      <div class="hp-node-stats">
        ${summary}
        ${tokenEstimate}
      </div>`;
    }
    function isNodeTranslationVisible(nodeId) {
        return (state.translationVisibleNodeIds ?? []).includes(nodeId);
    }
    function setNodeTranslationVisible(nodeId, visible) {
        const ids = new Set(state.translationVisibleNodeIds ?? []);
        if (visible)
            ids.add(nodeId);
        else
            ids.delete(nodeId);
        state.translationVisibleNodeIds = [...ids];
    }
    function renderNodeDisplayedContent(node) {
        const translation = node.translation;
        const visible = Boolean(translation && isNodeTranslationVisible(node.id));
        const stale = Boolean(translation && translation.sourceHash !== nodeSourceHash(node));
        const translationStatus = stale
            ? "원문 변경됨"
            : translation?.manuallyEdited
                ? "번역문 수정됨"
                : "";
        const busy = translatingNodeIds.has(node.id);
        if (cardInlineEditMode) {
            const editingTranslation = Boolean(visible && translation);
            const contentValue = editingTranslation ? translation.content : node.content;
            return `<div class="hp-card-inline-editor${editingTranslation ? " hp-node-translation" : ""}" data-node-id="${escapeHtml(node.id)}" data-inline-kind="${editingTranslation ? "translation" : "source"}">
        ${editingTranslation ? `<div class="hp-node-translation-head"><span>번역문</span>${translationStatus ? `<span class="hp-node-translation-stale">${translationStatus}</span>` : ""}</div>` : ""}
        <div class="hp-content hp-card-inline-content" contenteditable="true" role="textbox" aria-multiline="true" data-node-id="${escapeHtml(node.id)}" aria-label="${editingTranslation ? "번역문" : "원문"} 내용">${renderContentRichText(contentValue)}</div>
        ${editingTranslation ? `<div class="hp-node-translation-footer"><button class="hp-btn secondary small hp-node-translation-regenerate" type="button" data-node-id="${node.id}" ${busy ? "disabled" : ""}>${busy ? "재생성 중…" : "번역문 재생성"}</button>${translation?.model ? `<div class="hp-node-translation-model">${escapeHtml(translation.model)}</div>` : ""}</div>` : ""}
      </div>`;
        }
        if (visible && translation) {
            return `<div class="hp-node-translation">
        <div class="hp-node-translation-head">
          <span>번역문</span>
          ${translationStatus ? `<span class="hp-node-translation-stale">${translationStatus}</span>` : ""}
        </div>
        <div class="hp-node-translation-content hp-content">${renderContentRichText(translation.content)}</div>
        <div class="hp-node-translation-footer">
          <button class="hp-btn secondary small hp-node-translation-regenerate" type="button" data-node-id="${node.id}" ${busy ? "disabled" : ""}>${busy ? "재생성 중…" : "번역문 재생성"}</button>
          ${translation.model ? `<div class="hp-node-translation-model">${escapeHtml(translation.model)}</div>` : ""}
        </div>
      </div>`;
        }
        return `<div class="hp-content">${renderContentRichText(node.content)}</div>`;
    }
    function renderMemoryMetadataButton(node) {
        return `<button class="hp-btn secondary small icon-only hp-metadata-button" type="button" data-node-id="${escapeHtml(node.id)}" title="태그·분류 편집" aria-label="태그·분류 편집" aria-haspopup="dialog">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
        <path d="M4 6C4 3.79086 5.79086 2 8 2H9C9.55228 2 10 2.44772 10 3C10 3.55228 9.55228 4 9 4H8C6.89543 4 6 4.89543 6 6V20.0568L10.8375 16.6014C11.5329 16.1047 12.4671 16.1047 13.1625 16.6014L18 20.0568V13C18 12.4477 18.4477 12 19 12C19.5523 12 20 12.4477 20 13V20.0568C20 21.6836 18.1613 22.6298 16.8375 21.6843L12 18.2289L7.16248 21.6843C5.83874 22.6298 4 21.6836 4 20.0568V6Z" fill="currentColor"/>
        <path d="M17 3C17 2.44772 16.5523 2 16 2C15.4477 2 15 2.44772 15 3V5H13C12.4477 5 12 5.44772 12 6C12 6.55228 12.4477 7 13 7H15V9C15 9.55228 15.4477 10 16 10C16.5523 10 17 9.55228 17 9V7H19C19.5523 7 20 6.55228 20 6C20 5.44772 19.5523 5 19 5H17V3Z" fill="currentColor"/>
      </svg></button>`;
    }
    async function showMemoryMetadataDialog(node) {
        if (document.querySelector(".hp-metadata-dialog"))
            return;
        await flushInlineCardChanges();
        if (!getMemoryEntry(node))
            return;
        const overlay = document.createElement("div");
        overlay.className = "hp-edit-overlay";
        overlay.innerHTML = `<form class="hp-edit-box hp-metadata-dialog" role="dialog" aria-modal="true" aria-labelledby="hp-metadata-title">
      <h3 id="hp-metadata-title">태그·분류</h3>
      <label><span>분류</span><input class="hp-input" name="category" value="${escapeHtml(node.category ?? "")}" autocomplete="off"></label>
      <label><span>태그 (쉼표로 구분)</span><textarea class="hp-textarea" name="tags" rows="3">${escapeHtml((node.tags ?? []).join(", "))}</textarea></label>
      <p data-error role="status"></p>
      <div style="display:flex;justify-content:flex-end;gap:8px"><button class="hp-btn secondary" type="button" data-cancel>취소</button><button class="hp-btn hp-popup-save-action" type="button" data-save>저장</button></div>
    </form>`;
        document.body.appendChild(overlay);
        const form = overlay.querySelector("form");
        const category = form.elements.namedItem("category");
        const tags = form.elements.namedItem("tags");
        let saving = false;
        const close = () => {
            overlay.remove();
            document.querySelector(`.hp-metadata-button[data-node-id="${CSS.escape(node.id)}"]`)?.focus();
        };
        form.querySelector("[data-cancel]").addEventListener("click", () => { if (!saving)
            close(); });
        form.addEventListener("keydown", event => {
            if (event.key === "Escape") {
                event.preventDefault();
                if (!saving)
                    close();
            }
            if (event.key === "Tab") {
                const inputs = Array.from(form.querySelectorAll("input,textarea,button:not(:disabled)"));
                const first = inputs[0], last = inputs[inputs.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last.focus();
                }
                else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first.focus();
                }
            }
        });
        const saveButton = form.querySelector("[data-save]");
        const saveMetadata = async () => {
            if (saving)
                return;
            saving = true;
            saveButton.disabled = true;
            const previous = { category: node.category, tags: node.tags };
            let committed = false;
            try {
                if (!getMemoryEntry(node))
                    throw new Error("기억을 찾을 수 없습니다.");
                await commitMemoryEdit(node, {
                    category: category.value.trim() || undefined,
                    tags: [...new Set(tags.value.split(",").map(tag => tag.trim()).filter(Boolean))],
                });
                committed = true;
                invalidateUiSessionRenderData();
                overlay.remove();
                await renderUI(true);
            }
            catch (error) {
                if (!committed) {
                    node.category = previous.category;
                    node.tags = previous.tags;
                }
                form.querySelector("[data-error]").textContent = `저장하지 못했습니다. ${String(error)}`;
            }
            finally {
                saving = false;
                if (saveButton.isConnected)
                    saveButton.disabled = false;
            }
        };
        saveButton.addEventListener("click", () => { void saveMetadata(); });
        form.addEventListener("submit", event => {
            event.preventDefault();
            void saveMetadata();
        });
        category.focus();
    }
    async function showActivationCuesDialog(node) {
        if (document.querySelector(".hp-activation-dialog"))
            return;
        await flushInlineCardChanges();
        if (!getMemoryEntry(node))
            return;
        const overlay = document.createElement("div");
        overlay.className = "hp-edit-overlay";
        overlay.innerHTML = `<form class="hp-edit-box hp-activation-dialog" role="dialog" aria-modal="true" aria-labelledby="hp-activation-title">
      <h3 id="hp-activation-title">활성키</h3>
      <label><span>활성키</span><textarea class="hp-textarea" name="cues" rows="3">${escapeHtml((node.activationCues ?? []).join(", "))}</textarea></label>
      <p data-error role="status"></p>
      <div style="display:flex;justify-content:flex-end;gap:8px"><button class="hp-btn secondary" type="button" data-cancel>취소</button><button class="hp-btn hp-popup-save-action" type="button" data-save>저장</button></div>
    </form>`;
        document.body.appendChild(overlay);
        const form = overlay.querySelector("form");
        const cues = form.elements.namedItem("cues");
        let saving = false;
        const close = () => {
            overlay.remove();
            document.querySelector(`.hp-activation-button[data-node-id="${CSS.escape(node.id)}"]`)?.focus({ preventScroll: true });
        };
        form.querySelector("[data-cancel]").addEventListener("click", () => { if (!saving)
            close(); });
        form.addEventListener("keydown", event => {
            if (event.key === "Escape") {
                event.preventDefault();
                if (!saving)
                    close();
            }
            if (event.key === "Tab") {
                const inputs = Array.from(form.querySelectorAll("input,textarea,button:not(:disabled)"));
                const first = inputs[0], last = inputs[inputs.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last.focus();
                }
                else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first.focus();
                }
            }
        });
        const saveButton = form.querySelector("[data-save]");
        const saveMetadata = async () => {
            if (saving)
                return;
            saving = true;
            saveButton.disabled = true;
            const previous = [...(node.activationCues ?? [])];
            let committed = false;
            try {
                if (!getMemoryEntry(node))
                    throw new Error("기억을 찾을 수 없습니다.");
                await commitMemoryEdit(node, { activationCues: [...new Set(cues.value.split(",").map(cue => cue.trim()).filter(Boolean))] });
                committed = true;
                recordMemoryEdit(node, "activationCues", previous, [...(node.activationCues ?? [])]);
                invalidateUiSessionRenderData();
                overlay.remove();
                await renderUI(true);
            }
            catch (error) {
                if (!committed) {
                    node.activationCues = previous;
                }
                form.querySelector("[data-error]").textContent = `저장하지 못했습니다. ${String(error)}`;
            }
            finally {
                saving = false;
                if (saveButton.isConnected)
                    saveButton.disabled = false;
            }
        };
        saveButton.addEventListener("click", () => { void saveMetadata(); });
        form.addEventListener("submit", event => {
            event.preventDefault();
            void saveMetadata();
        });
        cues.focus();
    }
    function renderNodeTranslationAction(node) {
        const busy = translatingNodeIds.has(node.id);
        const visible = Boolean(node.translation && isNodeTranslationVisible(node.id));
        const label = busy ? "번역 중…" : !node.translation ? "번역 생성" : visible ? "번역 접기" : "번역 보기";
        const generationClass = !node.translation ? " hp-generate-node-translation" : "";
        return `<button class="hp-btn secondary small hp-toggle-node-translation${generationClass}" type="button" data-node-id="${node.id}" aria-expanded="${visible}" ${busy ? "disabled" : ""}>${label}</button>`;
    }
    const PROTO_MONTHS = {
        january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3,
        april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
        august: 8, aug: 8, september: 9, sep: 9, sept: 9,
        october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
    };
    function parseProtoCalendarDay(text) {
        const value = String(text ?? "").replace(/[–—]/g, "-");
        let m = value.match(/\b(\d{3,4})[.\/-](\d{1,2})[.\/-](\d{1,2})\b/);
        if (m)
            return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
        const monthNames = Object.keys(PROTO_MONTHS).sort((a, b) => b.length - a.length).join("|");
        m = value.match(new RegExp(`\\b(${monthNames})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{3,4}))?\\b`, "i"));
        if (m)
            return { year: m[3] ? Number(m[3]) : null, month: PROTO_MONTHS[m[1].toLowerCase()], day: Number(m[2]) };
        m = value.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthNames})(?:,?\\s+(\\d{3,4}))?\\b`, "i"));
        if (m)
            return { year: m[3] ? Number(m[3]) : null, month: PROTO_MONTHS[m[2].toLowerCase()], day: Number(m[1]) };
        m = value.match(/\b(\d{1,2})[.\/-](\d{1,2})\b/);
        if (m)
            return { year: null, month: Number(m[1]), day: Number(m[2]) };
        return null;
    }
    function protoDaySerial(day, fallbackYear) {
        const year = day.year ?? fallbackYear;
        if (day.month < 1 || day.month > 12 || day.day < 1 || day.day > 31)
            return null;
        // Gregorian serial is sufficient for relative UI even for fictional year numbers.
        const y = year - (day.month <= 2 ? 1 : 0);
        const era = Math.floor(y / 400);
        const yoe = y - era * 400;
        const mp = day.month + (day.month > 2 ? -3 : 9);
        const doy = Math.floor((153 * mp + 2) / 5) + day.day - 1;
        const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
        return era * 146097 + doe;
    }
    function isAiTimelineMessage(role) {
        return role === "char" || role === "assistant" || role === "model";
    }
    function compileTimelineDateRegex(settings) {
        const source = settings.timelineDateRegex.trim();
        if (!source)
            return null;
        try {
            return new RegExp(source, settings.timelineDateRegexFlags.trim());
        }
        catch (_) {
            return null;
        }
    }
    function detectCurrentTimelineDate(settings = currentCharacterTimelineSettings) {
        const regex = compileTimelineDateRegex(settings);
        if (!regex)
            return null;
        const captureGroup = Number.isInteger(settings.dateCaptureGroup)
            ? Math.max(0, settings.dateCaptureGroup)
            : 1;
        for (let i = currentRawMessages.length - 1; i >= 0; i--) {
            const message = currentRawMessages[i];
            if (!message || !isAiTimelineMessage(message.role))
                continue;
            regex.lastIndex = 0;
            let match;
            while ((match = regex.exec(message.content)) !== null) {
                const rawDate = match[captureGroup];
                if (typeof rawDate === "string") {
                    const parsedDate = parseProtoCalendarDay(rawDate);
                    if (parsedDate) {
                        return {
                            parsedDate,
                            rawDate: rawDate.trim(),
                            messageIndex: message.index,
                        };
                    }
                }
                if (!regex.global && !regex.sticky)
                    break;
                if (match[0] === "")
                    regex.lastIndex += 1;
            }
        }
        return null;
    }
    function formatProtoRelativeAge(memoryTime) {
        const current = currentUiTimelineDetection?.parsedDate ?? null;
        const memory = parseProtoCalendarDay(memoryTime);
        if (!current || !memory)
            return "";
        const fallbackYear = current.year ?? memory.year ?? 2000;
        const currentSerial = protoDaySerial(current, fallbackYear);
        const memorySerial = protoDaySerial(memory, fallbackYear);
        if (currentSerial === null || memorySerial === null)
            return "";
        const diff = currentSerial - memorySerial;
        if (diff === 0)
            return "오늘";
        if (diff > 0)
            return diff >= 7 ? `${Math.floor(diff / 7)}주 전` : `${diff}일 전`;
        const futureDays = Math.abs(diff);
        return futureDays >= 7 ? `${Math.floor(futureDays / 7)}주 후` : `${futureDays}일 후`;
    }
    function protoRelativeAgeDays(memoryTime, current) {
        const memory = parseProtoCalendarDay(memoryTime);
        if (!current || !memory)
            return null;
        const fallbackYear = current.year ?? memory.year ?? 2000;
        const currentSerial = protoDaySerial(current, fallbackYear);
        const memorySerial = protoDaySerial(memory, fallbackYear);
        return currentSerial === null || memorySerial === null ? null : currentSerial - memorySerial;
    }
    function buildCompactRetrievalLedgerRow(input) {
        const metadata = getDetectedChatUiMetadataForCurrentContext();
        const charName = metadata?.charName ?? state.ownerCharName ?? currentCharId;
        const chatName = metadata?.chatName ?? state.ownerChatName ?? currentChatId;
        const ageDays = protoRelativeAgeDays(input.node.time, input.timelineDetection?.parsedDate ?? null);
        const score = input.scores ?? {};
        return [
            COMPACT_RETRIEVAL_LEDGER_VERSION, String(input.at), compactLedgerIdentity(currentCharId, charName),
            compactLedgerIdentity(currentChatId, chatName), compactLedgerField(input.node.id), input.source,
            input.rank == null ? "-" : String(input.rank), input.selected ? "1" : "0",
            String(Math.max(0, Math.floor(input.queryCount))), compactLedgerField(input.timelineDetection?.rawDate ?? ""),
            ageDays == null ? "-" : String(ageDays), compactLedgerNumber(score.content),
            compactLedgerNumber(score.dialogueSemantic), compactLedgerNumber(score.dialogueSemanticContribution),
            compactLedgerNumber(score.dialogueLexical), compactLedgerNumber(score.dialogueLexicalContribution),
            compactLedgerNumber(score.activation), compactLedgerNumber(score.activationContribution),
            compactLedgerNumber(score.likeBonus), compactLedgerNumber(score.total),
            input.source === "S" ? compactLedgerNumber(dialogueEmbeddingWeight) : "-",
            input.source === "S" ? compactLedgerNumber(dialogueLocalWeight) : "-",
            input.source === "S" ? compactLedgerNumber(activationCueWeight) : "-",
            input.source === "S" ? compactLedgerNumber(likeBonusBase) : "-",
        ].join("|");
    }
    function renderNodeLikeAction(node) {
        const remaining = getLikeRemaining(node);
        const active = remaining > 0;
        const hadLike = Number.isFinite(node.likedAt);
        const emptyPercent = ((1 - remaining) * 100).toFixed(2);
        const title = active ? "좋아요 해제" : hadLike ? "좋아요 다시 누르기" : "좋아요";
        return `<button class="hp-like-node" type="button" data-node-id="${node.id}" data-liked="${active}" aria-pressed="${active}" aria-label="${title}" title="${title}" style="--hp-like-empty:${emptyPercent}%;">
      <span class="material-symbols-outlined hp-like-icon hp-like-outline" aria-hidden="true">favorite</span>
      <span class="material-symbols-outlined hp-like-icon hp-like-fill" aria-hidden="true">favorite</span>
    </button>`;
    }
    function formatEntryMessageRange(entry) {
        const indices = getEntryMessageIndices(entry);
        return indices.length ? `#${indices[0]} – #${indices[indices.length - 1]}` : "";
    }
    function renderEntryDetails(entry, nodeId) {
        const count = entry.linkedMessages.length;
        return `<details class="hp-source-details hp-view-node-msgs${count ? "" : " hp-orphan-disabled"}" data-entry-position="${entryPosition(entry)}"${nodeId ? ` data-node-id="${escapeHtml(nodeId)}"` : ""}>
      <summary class="hp-source-summary">연결된 메시지 (${count}) <span>${escapeHtml(formatEntryMessageRange(entry))}</span></summary></details>`;
    }
    function getSelectedMemoryEntries() {
        const live = new Set(state.entries);
        for (const entry of selectedMemoryEntries)
            if (!live.has(entry))
                selectedMemoryEntries.delete(entry);
        return state.entries.filter(entry => selectedMemoryEntries.has(entry));
    }
    function renderEntrySelection(entry) {
        if (!cardInlineEditMode || entry === summarizationPreviewEntry)
            return "";
        return `<input type="checkbox" class="hp-entry-select" data-entry-position="${entryPosition(entry)}" aria-label="엔트리 선택" ${selectedMemoryEntries.has(entry) ? "checked" : ""}>`;
    }
    function mergeMemoryEntries(entries) {
        const ordered = sortEntriesByMessageIndex(entries, "asc");
        const memories = ordered.flatMap(entry => entry.memory ? [entry.memory] : []);
        // Slots point into the shared message table; keep their identities intact.
        const linkedMessages = [...new Set(ordered.flatMap(entry => entry.linkedMessages))].sort((a, b) => {
            const ai = getEntryMessageIndices({ memory: null, linkedMessages: [a] })[0] ?? state.messages[String(a)]?.index ?? a;
            const bi = getEntryMessageIndices({ memory: null, linkedMessages: [b] })[0] ?? state.messages[String(b)]?.index ?? b;
            return ai - bi || a - b;
        });
        const memory = memories.length ? {
            id: nextNodeId(),
            time: memories[0].time,
            content: memories.map(node => node.content).join(""),
            createdAt: Math.min(...memories.map(node => node.createdAt)),
            category: [...new Set(memories.map(node => node.category).filter(Boolean))].join(", ") || undefined,
            tags: [...new Set(memories.flatMap(node => node.tags ?? []))],
            activationCues: [...new Set(memories.flatMap(node => node.activationCues ?? []))],
            favorite: memories.some(node => node.favorite),
            likedAt: Math.max(...memories.map(node => node.likedAt ?? 0)) || undefined,
        } : null;
        // A fresh memory identity avoids reusing partial translations, vectors, or scores.
        return { memory, linkedMessages };
    }
    async function applySelectedEntryAction(action) {
        if (bulkEntryActionInProgress)
            return;
        bulkEntryActionInProgress = true;
        const ownerState = state;
        const contextKey = getUiContextKey();
        try {
            const entries = getSelectedMemoryEntries();
            if (entries.length < (action === "merge" ? 2 : 1))
                return;
            const ok = await showConfirmDialog(`선택한 엔트리 ${entries.length}개를 ${action === "merge" ? "합칠까요" : "삭제할까요"}?`);
            if (!ok || state !== ownerState || contextKey !== getUiContextKey())
                return;
            await flushInlineCardChanges();
            if (state !== ownerState || contextKey !== getUiContextKey() || entries.some(entry => !state.entries.includes(entry)))
                return;
            const merged = action === "merge" ? mergeMemoryEntries(entries) : null;
            const insertionIndex = Math.min(...entries.map(entry => state.entries.indexOf(entry)));
            for (const entry of entries) {
                if (entry.memory)
                    removeNodeById(entry.memory.id);
                else
                    state.entries.splice(state.entries.indexOf(entry), 1);
            }
            if (merged)
                state.entries.splice(insertionIndex, 0, merged);
            selectedMemoryEntries.clear();
            await saveState();
            await renderUI(true);
        }
        finally {
            bulkEntryActionInProgress = false;
        }
    }
    function renderEmptyEntryRow(entry) {
        return `<div class="hp-empty-entry-row${entry === summarizationPreviewEntry ? " hp-summary-preview-card" : ""}">
      <div class="hp-node-footer-source">${renderEntrySelection(entry)}${renderEntryDetails(entry)}</div>
      <div class="hp-node-message-viewer"></div></div>`;
    }
    function renderEmptyEntriesSection(entries) {
        return `<details class="hp-card hp-empty-entries"><summary class="hp-empty-entries-summary">빈 엔트리 (${entries.length})</summary>
      <div class="hp-empty-entries-list">${entries.map(renderEmptyEntryRow).join("")}</div></details>`;
    }
    function renderNodeCard(node, isRecent = false, linkPosition = "single") {
        const parentChunk = getMemoryEntry(node);
        const scores = state.lastNodeScores?.[node.id] ?? null;
        const isChosen = state.lastChosenNodeIds?.includes(node.id) ?? false;
        const memoryStatusBadge = `${isChosen ? `<span class="hp-memory-status-badge similar" title="현재 컨텍스트와 유사한 기억">Similar</span>` : ""}${isRecent ? `<span class="hp-memory-status-badge recent" title="최근 메모리">Recent</span>` : ""}`;
        const memoryClasses = memoryStateClasses(isChosen, isRecent);
        const tagChips = (node.tags ?? []).filter(Boolean)
            .map((tag) => `<span class="hp-proto-chip hp-proto-tag" title="${escapeHtml(tag)}">${escapeHtml(tag)}</span>`).join("");
        const categoryChip = node.category?.trim()
            ? `<span class="hp-proto-chip hp-proto-category" title="${escapeHtml(node.category.trim())}">${escapeHtml(node.category.trim())}</span>`
            : "";
        const relativeAge = formatProtoRelativeAge(node.time);
        const entryLinkClass = linkPosition === "single" ? "" : ` hp-sourcegroup-link-${linkPosition}`;
        return `
    <div class="hp-card${memoryClasses}${entryLinkClass}" data-node-id="${node.id}">
      <div class="hp-card-header hp-node-primary-row">
        <span class="hp-node-heading hp-proto-heading">
          <span class="hp-node-id-group">
            ${parentChunk ? renderEntrySelection(parentChunk) : ""}
            <span class="hp-proto-id">#${memoryDisplayNumber(node)}</span>
          </span>
          ${categoryChip}
          ${cardInlineEditMode ? `<input class="hp-card-inline-time" data-node-id="${node.id}" value="${escapeHtml(node.time)}" aria-label="기억 제목">` : `<strong class="hp-proto-time">${escapeHtml(node.time)}</strong>`}
          ${relativeAge ? `<span class="hp-proto-age">${escapeHtml(relativeAge)}</span>` : ""}
        </span>
        <span class="hp-node-status-slot">${memoryStatusBadge}</span>
      </div>
      <div class="hp-node-action-row">
        <span class="hp-node-action-left">          <button class="hp-btn small hp-delete-node hp-node-delete-action has-icon icon-only" type="button" data-node-id="${node.id}" aria-label="삭제" title="삭제"><span class="material-symbols-outlined hp-icon-delete-filled" aria-hidden="true">delete</span></button>
          ${renderNodeTranslationAction(node)}${renderMemoryMetadataButton(node)}<button class="hp-btn secondary small hp-activation-button" type="button" data-node-id="${escapeHtml(node.id)}" aria-haspopup="dialog">활성키</button></span>
        <span class="hp-node-tag-strip">${tagChips}</span>
      </div>
      ${renderNodeDisplayedContent(node)}
      ${renderNodeStats(node, scores)}
      <div class="hp-proto-source-row hp-node-footer">
        <div class="hp-node-footer-source">${parentChunk ? renderEntryDetails(parentChunk, node.id) : ""}</div>
        <span class="hp-node-footer-actions">
          <span class="hp-node-menu-wrap">
            <button class="hp-node-menu-button" type="button" data-node-id="${node.id}" aria-label="기억 메뉴" title="기억 메뉴" aria-expanded="false"><span class="material-symbols-outlined" aria-hidden="true">menu</span></button>
            <span class="hp-node-menu-popover" hidden>
              <button class="hp-node-menu-item hp-node-reroll" type="button" data-node-id="${node.id}" aria-label="재요약" title="재요약"><span class="material-symbols-outlined" aria-hidden="true">cached</span></button>
              <button class="hp-node-menu-item hp-node-lorebook-placeholder" type="button" data-node-id="${node.id}" aria-label="로어북 내보내기" title="로어북 내보내기"><span class="material-symbols-outlined" aria-hidden="true">book_5</span></button>
            </span>
          </span>
          <button class="hp-fav-node" type="button" data-node-id="${node.id}" data-favorite="${node.favorite === true}" title="${node.favorite ? "즐겨찾기 해제" : "즐겨찾기"}" aria-label="${node.favorite ? "즐겨찾기 해제" : "즐겨찾기"}"><span class="material-symbols-outlined" aria-hidden="true">star</span></button>
          ${renderNodeLikeAction(node)}
        </span>
      </div>
      ${parentChunk ? `<div class="hp-node-message-viewer" data-node-id="${escapeHtml(node.id)}"></div>` : ""}
    </div>`;
    }
    // ── Panel: Calendar ──────────────────────────────────────────────────────
    // ── Panel: Settings ──────────────────────────────────────────────────────
    /** Build the final settings layout directly; no post-render DOM relocation. */
    function renderSettingsWorkspace() {
        // Never carry a chat-local note or regex selection into a different chat.
        const contextKey = getUiContextKey();
        if (settingsDraftContextKey !== contextKey) {
            settingsEdits.clear();
            regexSettingsDraft = null;
            memoryInjectionDraft = null;
            settingsDraftContextKey = contextKey;
        }
        const memoryEstimate = estimateMemoryBudget(maxMemoryTokens, recentMemoryRatio);
        const recentPercent = Math.round(memoryEstimate.recentRatio * 100);
        const chosenPercent = 100 - recentPercent;
        return `<div class="hp-panel${activeTab === "settings" ? " active" : ""}" data-panel="settings">
    <div class="hp-settings-panel hp-settings-workspace">
<p class="hp-settings-save-help">프리셋·공통 설정은 탭 이동 / 하피크 닫기 시 저장됩니다. 프리셋과 주입 설정을 변경·복사할 때는 기존 값을 먼저 저장합니다. 저장 전 새로고침하면 미저장 편집을 취소합니다.</p>
<h3>프리셋 설정 · 이동 시 자동 저장</h3>
${renderPresetsPanel()}
<div class="hp-settings-field-grid hp-summary-prompt-field">
        <h4 class="hp-settings-field-title" style="color:var(--hp-text-strong);">요약 프롬프트</h4>
        <textarea class="hp-textarea hp-prompt-field" id="hp-prompt-textarea" style="height:400px;">${escapeHtml(summaryPrompt)}</textarea>
      </div>
<div class="hp-row hp-settings-form-row hp-settings-form-row-mobile-stack hp-settings-form-row-compact">
          <span class="hp-label">요약본당 최대 메시지 수</span>
          <input class="hp-input" type="number" id="hp-chunk-size" value="${chunkSize}" min="2" max="100" style="width:100px;">
        </div>
<div class="hp-row hp-settings-form-row hp-settings-form-row-mobile-stack hp-settings-form-row-compact">
          <span class="hp-label hp-label-with-help">요약 후 남길 메세지${renderSettingsHelp(`자동 요약 시 최신 미요약 메시지를 이 개수 이상 남깁니다.`)}</span>
          <input class="hp-input" type="number" id="hp-summary-retain-messages" value="${retainedMessagesAfterSummary}" min="0" max="1000" style="width:100px;">
          
        </div>
<div class="hp-row hp-settings-form-row hp-settings-form-row-toggle">
          <span class="hp-label">User 메시지 포함</span>
          <label class="hp-toggle">
            <input type="checkbox" id="hp-include-user" ${includeUserMessages ? "checked" : ""}>
            <span class="slider"></span>
          </label>
        </div>
<div class="hp-row hp-settings-form-row hp-settings-form-row-mobile-stack hp-settings-form-row-compact">
          <span class="hp-label hp-label-with-help">임베딩 요청 메시지 수${renderSettingsHelp(`임베딩 유사도 측정에 포함할 최근 메시지 개수`)}</span>
          <input class="hp-input" type="number" id="hp-embedding-context" value="${embeddingContextMessages}" min="1" max="50" style="width:100px;">
          
        </div>
<div class="hp-row hp-settings-form-row hp-settings-form-row-mobile-stack hp-settings-form-row-compact">
        <span class="hp-label">기억 토큰 <span title="${escapeHtml(memoryTokenizerStatusTitle())}" style="margin-left:6px;color:var(--hp-text-muted);font-size:var(--hp-ui-font-meta);font-weight:500;white-space:nowrap;">${escapeHtml(memoryTokenizerStatusLabel())}</span></span>
        <input class="hp-input" type="number" id="hp-max-tokens" value="${maxMemoryTokens}" min="100" step="100" style="width:110px;">
      </div>
<div class="hp-memory-ratio-control">
        <div class="hp-memory-ratio-labels">
          <span>최근 메모리 <b id="hp-recent-memory-percent">${recentPercent}%</b></span>
          <span>유사 메모리 <b id="hp-chosen-memory-percent">${chosenPercent}%</b></span>
        </div>
        <input class="hp-memory-ratio-slider" id="hp-recent-memory-ratio" type="range" min="0" max="100" step="1" value="${recentPercent}" style="--hp-memory-split:${recentPercent}%;" aria-label="최근 메모리 비율">
        <div class="hp-memory-ratio-estimates">
          <span id="hp-recent-memory-estimate">예상 ${memoryEstimate.recentBudget}토큰 · 최근 메모리 ${memoryEstimate.recentNodeCount}개</span>
          <span id="hp-chosen-memory-estimate">예상 ${memoryEstimate.chosenBudget}토큰</span>
        </div>
      </div>
<div class="hp-settings-field-grid">
        <span class="hp-label hp-label-with-help">기억 구분자${renderSettingsHelp(`예: <code>\\n\\n</code> 또는 <code>\\n---\\n</code>`)}</span>
        <input class="hp-input hp-prompt-field" type="text" id="hp-memory-separator" value="${escapeHtml(memorySeparator)}" placeholder="기억 사이에 들어갈 문자열">
        
      </div>
<div class="hp-context-format-field hp-settings-field-grid">
        <span class="hp-label">컨텍스트 출력 포맷</span>
        <p style="margin:0;font-size:12px;color:var(--hp-text-muted);">
          아래 플레이스홀더가 실제 값으로 치환됩니다 (각 문자열 클릭/터치 시 복사됩니다):<br>
          <code data-copy-text="[[time]]">[[time]]</code> = 시간, <code data-copy-text="[[content]]">[[content]]</code> = 내용
        </p>
        <textarea class="hp-textarea hp-prompt-field" id="hp-event-format" style="height:100px;">${escapeTextareaValue(eventFormat)}</textarea>
      </div>
<h3>공통 설정 · 이동 시 자동 저장</h3>
<p>요약 프리셋과 독립적입니다. 요약가의 노트는 현재 채팅, 주입 설정은 네임스페이스별로 보관됩니다.</p>
<div class="hp-settings-field-grid">
        <span class="hp-label">요약가의 노트 · 이 채팅 전용</span>
        <textarea class="hp-textarea hp-prompt-field" id="hp-summarizer-note" style="height:120px;" placeholder="이 채팅의 관계성, 세계관, 요약 시 중요하게 볼 점 등을 자유롭게 적습니다.">${escapeHtml(state.summarizerNote ?? "")}</textarea>
      </div>
<div class="hp-settings-divider" role="separator" aria-hidden="true"></div>
<div class="hp-settings-collapse">
<button class="hp-settings-collapse-toggle" id="hp-embedding-settings-toggle" type="button" aria-expanded="false" aria-controls="hp-embedding-settings-content"><span>임베딩 설정</span><span class="hp-settings-collapse-chevron" aria-hidden="true">›</span></button>
<div class="hp-settings-collapse-content" id="hp-embedding-settings-content" hidden><div class="hp-row hp-settings-form-row hp-settings-form-row-mobile-stack">
          <span class="hp-label hp-label-with-help">임베딩 URL${renderSettingsHelp(`OpenAI-호환 /v1/embeddings 엔드포인트`)}</span>
          <input class="hp-input" type="text" id="hp-embedding-url" value="${escapeHtml(embeddingUrl)}" placeholder="http://localhost:8080/embeddings">
          
        </div>
<div class="hp-row hp-settings-form-row hp-settings-form-row-mobile-stack">
          <span class="hp-label">API 키</span>
          <input class="hp-input" type="password" id="hp-embedding-api-key" value="${escapeHtml(embeddingApiKey)}" placeholder="sk-...">
        </div>
        <div class="hp-row hp-settings-form-row hp-settings-form-row-mobile-stack">
          <span class="hp-label">임베딩 모델</span>
          <input class="hp-input" type="text" id="hp-embedding-model" value="${escapeHtml(embeddingModel)}" placeholder="text-embedding-3-small">
        </div></div></div>
<div class="hp-settings-divider" role="separator" aria-hidden="true"></div>
${renderRegexPanel()}

<div class="hp-settings-open-box" id="hp-memory-injection-settings">
        <div class="hp-settings-open-box-title">메인 모델 장기기억 주입</div>
        <div class="hp-settings-open-box-content">
          <div class="hp-row" style="align-items:stretch;">
            <select class="hp-select" id="hp-memory-injection-profile-select" aria-label="장기기억 주입 네임스페이스" style="min-width:200px;flex:1;"><option value="">저장된 주입 설정 없음</option></select>
            
          </div>
          <div class="hp-row" style="gap:6px;flex-wrap:wrap;">
            <button class="hp-btn secondary" id="hp-add-memory-injection-profile" type="button">추가</button>
            <button class="hp-btn secondary" id="hp-copy-memory-injection-profile" type="button">복사</button>
            <button class="hp-btn danger" id="hp-delete-memory-injection-profile" type="button">삭제</button>
          </div>
          <div class="hp-settings-field-grid">
            <span class="hp-label hp-label-with-help">네임스페이스${renderSettingsHelp(`비어 있으면 <b>네임스페이스 없음(기본 fallback)</b>으로 저장됩니다. 현재 프롬프트 namespace가 없거나 저장된 namespace와 매칭되지 않을 때 이 설정을 사용합니다.`)}</span>
            <input class="hp-input hp-prompt-field" type="text" id="hp-memory-injection-namespace" value="${escapeHtml(memoryInjectionDraft?.namespace ?? memoryInjectionNamespace)}" placeholder="비워두면 기본 fallback">
            
          </div>
          <div class="hp-settings-field-grid">
            <span class="hp-label hp-label-with-help">주입 앵커${renderSettingsHelp(`실제 줄바꿈과 <code>\\n</code> 표기를 모두 사용할 수 있습니다.`)}</span>
            <textarea class="hp-textarea hp-prompt-field" id="hp-memory-injection-anchor" style="height:82px;" placeholder="# Chat">${escapeTextareaValue(memoryInjectionDraft?.anchor ?? memoryInjectionAnchor)}</textarea>
            
          </div>
          <div class="hp-settings-field-grid">
            <span class="hp-label hp-label-with-help">기억 블럭${renderSettingsHelp(`입력한 공백/줄바꿈은 그대로 보존되며 <code>\\n</code>도 줄바꿈으로 해석됩니다.`)}</span>
            <textarea class="hp-textarea hp-prompt-field" id="hp-memory-injection-template" style="height:160px;" placeholder="{{hypa}}">${escapeTextareaValue(memoryInjectionDraft?.template ?? memoryInjectionTemplate)}</textarea>
            
          </div>
        </div>
      </div>
<div class="hp-settings-collapse">
<button class="hp-settings-collapse-toggle" id="hp-translation-settings-toggle" type="button" aria-expanded="false" aria-controls="hp-translation-settings-content"><span>노드 번역 설정</span><span class="hp-settings-collapse-chevron" aria-hidden="true">›</span></button>
<div class="hp-settings-collapse-content" id="hp-translation-settings-content" hidden>
        <div class="hp-row hp-settings-form-row hp-settings-form-row-mobile-stack">
          <span class="hp-label">노드 번역 API URL</span>
          <input class="hp-input" type="text" id="hp-node-translation-url" value="${escapeHtml(nodeTranslationApiUrl)}" placeholder="OpenAI 호환 /v1/chat/completions">
        </div>
        <div class="hp-row hp-settings-form-row hp-settings-form-row-mobile-stack">
          <span class="hp-label">노드 번역 API Key</span>
          <input class="hp-input" type="password" id="hp-node-translation-key" value="${escapeHtml(nodeTranslationApiKey)}" autocomplete="off" placeholder="sk-...">
        </div>
        <div class="hp-row hp-settings-form-row hp-settings-form-row-mobile-stack">
          <span class="hp-label">노드 번역 모델</span>
          <input class="hp-input" type="text" id="hp-node-translation-model" value="${escapeHtml(nodeTranslationModel)}" placeholder="번역 모델 이름">
        </div>
        <div class="hp-row" style="justify-content:flex-end;">
          <button class="hp-btn secondary small" type="button" id="hp-test-node-translation-api">연결 테스트</button>
        </div>
        <div class="hp-row hp-settings-form-row hp-settings-form-row-compact">
          <span class="hp-label">번역 대상 언어</span>
          <input class="hp-input" type="text" id="hp-node-translation-language" value="${escapeHtml(nodeTranslationLanguage)}" style="width:100px;">
        </div>
        <div class="hp-row hp-settings-form-row hp-settings-form-row-compact">
          <span class="hp-label">번역 최대 출력 토큰</span>
          <input class="hp-input" type="number" id="hp-node-translation-max-tokens" value="${nodeTranslationMaxTokens}" min="128" max="65536" step="128" style="width:100px;">
        </div>
        <div class="hp-row hp-settings-form-row hp-settings-form-row-compact">
          <span class="hp-label">번역 온도</span>
          <input class="hp-input" type="number" id="hp-node-translation-temperature" value="${nodeTranslationTemperature}" min="0" max="2" step="0.1" style="width:100px;">
        </div>
        <div class="hp-settings-field-grid">
          <span class="hp-label">노드 번역 프롬프트</span>
          <textarea class="hp-textarea hp-prompt-field" id="hp-node-translation-prompt" style="height:150px;">${escapeHtml(nodeTranslationPrompt)}</textarea>
        </div>
      </div></div>
<h3>검색 설정 · 버튼으로 저장</h3>
<div class="hp-settings-collapse">
<button class="hp-settings-collapse-toggle" id="hp-retrieval-weight-settings-toggle" type="button" aria-expanded="false" aria-controls="hp-retrieval-weight-settings-content"><span>Query 문단 묶음 & 검색 신호 · 별도 저장</span><span class="hp-settings-collapse-chevron" aria-hidden="true">›</span></button>
<div class="hp-settings-collapse-content" id="hp-retrieval-weight-settings-content" hidden>
<div class="hp-row hp-settings-form-row hp-settings-form-row-mobile-stack hp-settings-form-row-compact">
          <span class="hp-label hp-label-with-help">Query 문단 묶음${renderSettingsHelp(`최근 메시지를 몇 문단씩 한 Query로 묶을지 정합니다. 1이면 문단마다 분리합니다.`)}</span>
          <input class="hp-input" type="number" id="hp-query-paragraph-group-size" value="${queryParagraphGroupSize}" min="1" max="20" step="1" style="width:100px;">
          
        </div>
<p>이 영역은 아래 저장 버튼을 눌러야 적용됩니다. 탭 이동·프리셋 변경으로는 저장되지 않습니다.</p>
        <p style="margin:0 0 10px;font-size:12px;color:var(--hp-text-muted);">Similar 후보의 최종 점수에 더할 신호의 세기를 정합니다. 모든 채팅과 요약 프리셋에 공통으로 적용됩니다.</p>
        <div class="hp-row hp-settings-form-row hp-settings-form-row-mobile-stack hp-settings-form-row-compact">
          <span class="hp-label hp-label-with-help">의미 대사${renderSettingsHelp(`현재 대사와 기억 속 대사의 임베딩 유사도에 곱합니다. 기본값 <code>${DEFAULT_DIALOGUE_EMBEDDING_WEIGHT}</code>`)}</span>
          <input class="hp-input" type="number" id="hp-dialogue-embedding-weight" value="${dialogueEmbeddingWeight}" min="0" step="0.01" inputmode="decimal" style="width:110px;">
        </div>
        <div class="hp-row hp-settings-form-row hp-settings-form-row-mobile-stack hp-settings-form-row-compact">
          <span class="hp-label hp-label-with-help">어휘 대사${renderSettingsHelp(`현재 대사와 기억 속 대사의 어휘 일치 점수에 곱합니다. 기본값 <code>${DEFAULT_DIALOGUE_LOCAL_WEIGHT}</code>`)}</span>
          <input class="hp-input" type="number" id="hp-dialogue-local-weight" value="${dialogueLocalWeight}" min="0" step="0.01" inputmode="decimal" style="width:110px;">
        </div>
        <div class="hp-row hp-settings-form-row hp-settings-form-row-mobile-stack hp-settings-form-row-compact">
          <span class="hp-label hp-label-with-help">활성 키${renderSettingsHelp(`활성 키 매칭 점수에 곱합니다. 기본값 <code>${DEFAULT_ACTIVATION_CUE_WEIGHT}</code>`)}</span>
          <input class="hp-input" type="number" id="hp-activation-cue-weight" value="${activationCueWeight}" min="0" step="0.01" inputmode="decimal" style="width:110px;">
        </div>
        <div class="hp-row hp-settings-form-row hp-settings-form-row-mobile-stack hp-settings-form-row-compact">
          <span class="hp-label hp-label-with-help">좋아요 기본 보너스${renderSettingsHelp(`좋아요 직후 더할 최대값입니다. 4일 동안 선형으로 감소합니다. 기본값 <code>${DEFAULT_LIKE_BONUS_BASE}</code>`)}</span>
          <input class="hp-input" type="number" id="hp-like-bonus-base" value="${likeBonusBase}" min="0" step="0.01" inputmode="decimal" style="width:110px;">
        </div>
<button class="hp-btn primary" id="hp-save-search-settings" type="button">검색 설정 저장</button><p id="hp-search-save-status" role="status" aria-live="polite"></p>
</div></div>
</div></div>`;
    }
    function renderLorebookWorkspace() {
        const context = lorebookPageContext;
        const characterCount = context?.lores.filter((lore) => lore.source === "character").length ?? 0;
        const chatCount = context?.lores.filter((lore) => lore.source === "chat").length ?? 0;
        const status = lorebookPageLoading
            ? `<div class="hp-lorebook-status">현재 캐릭터와 채팅의 로어북을 불러오는 중…</div>`
            : lorebookPageError
                ? `<div class="hp-lorebook-status error">불러오기 실패 · ${escapeHtml(lorebookPageError)}</div>`
                : !context
                    ? `<div class="hp-lorebook-empty">로어북 페이지를 열면 현재 캐릭터와 채팅의 로어북을 불러옵니다.</div>`
                    : context.lores.length === 0
                        ? `<div class="hp-lorebook-empty">본문이 있는 캐릭터·채팅 로어북이 없습니다.</div>`
                        : `<div class="hp-lorebook-list">${context.lores.map((lore) => `
                <article class="hp-lorebook-entry" data-lore-uid="${escapeHtml(lore.uid)}">
                  <div class="hp-lorebook-entry-head">
                    <span class="hp-lorebook-source ${lore.source}">${escapeHtml(lore.sourceLabel)}</span>
                    <span class="hp-lorebook-entry-title">${escapeHtml(lore.title)}</span>
                    ${lore.alwaysActive ? `<span class="hp-lorebook-entry-state">상시 활성</span>` : ""}
                  </div>
                  <div class="hp-lorebook-entry-content">${escapeHtml(lore.content)}</div>
                </article>
              `).join("")}</div>`;
        return `<div class="hp-panel${activeTab === "lorebook" ? " active" : ""}" data-panel="lorebook">
      <div class="hp-lorebook-workspace">
        <div class="hp-lorebook-header">
          <div class="hp-lorebook-header-copy">
            <h3>로어북</h3>
            <p>${context ? `${escapeHtml(context.characterName)} · ${escapeHtml(context.chatName)}` : "현재 캐릭터·채팅의 로어북을 읽어옵니다."}</p>
          </div>
          <button class="hp-btn secondary small has-icon" id="hp-refresh-lorebook" type="button" ${lorebookPageLoading ? "disabled" : ""}>
            <span class="material-symbols-outlined" aria-hidden="true">cached</span><span>새로고침</span>
          </button>
        </div>
        <div class="hp-lorebook-retrieval-settings">
          <div class="hp-lorebook-retrieval-row">
            <span class="hp-label">로어북 토큰</span>
            <input class="hp-input" type="number" id="hp-lorebook-max-tokens" value="${maxLorebookTokens}" min="0" step="1" inputmode="numeric">
          </div>
          <div class="hp-lorebook-retrieval-row">
            <span class="hp-label">로어북 구분자</span>
            <input class="hp-input" type="text" id="hp-lorebook-separator" value="${escapeHtml(lorebookSeparator)}" placeholder="로어북 사이에 들어갈 문자열">
          </div>
          <div class="hp-lorebook-retrieval-actions">
            <button class="hp-btn primary small" id="hp-save-lorebook-retrieval" type="button">저장</button>
            <button class="hp-btn secondary small" id="hp-clear-lorebook-embedding-cache" type="button">임베딩 캐시 초기화</button>
            <span class="hp-lorebook-save-status" id="hp-lorebook-save-status"></span>
          </div>
        </div>
        ${context && !lorebookPageLoading ? `<div class="hp-lorebook-summary"><span class="hp-stat">전체 <b>${context.lores.length}</b>개</span><span class="hp-stat">캐릭터 <b>${characterCount}</b>개</span><span class="hp-stat">채팅 <b>${chatCount}</b>개</span></div>` : ""}
        ${status}
      </div>
    </div>`;
    }
    let settingsHelpSequence = 0;
    function renderSettingsHelp(content) {
        const id = `hp-settings-help-${++settingsHelpSequence}`;
        return `<span class="hp-help-wrap"><button class="hp-help-button" type="button" aria-label="도움말" aria-describedby="${id}"><span class="material-symbols-outlined" aria-hidden="true">help</span></button><span class="hp-help-tooltip" id="${id}" role="tooltip">${content}</span></span>`;
    }
    function attachSettingsHelpEvents() {
        document.querySelectorAll(".hp-help-button").forEach((button) => {
            const tooltip = document.getElementById(button.getAttribute("aria-describedby") ?? "");
            if (!tooltip)
                return;
            const positionTooltip = () => {
                tooltip.style.left = "0px";
                tooltip.style.top = "0px";
                const ownerRect = button.getBoundingClientRect();
                const tooltipRect = tooltip.getBoundingClientRect();
                const viewportPadding = 8;
                const centeredLeft = ownerRect.left + ownerRect.width / 2 - tooltipRect.width / 2;
                const maxLeft = Math.max(viewportPadding, window.innerWidth - tooltipRect.width - viewportPadding);
                const left = Math.min(Math.max(viewportPadding, centeredLeft), maxLeft);
                let top = ownerRect.bottom + 6;
                if (top + tooltipRect.height > window.innerHeight - viewportPadding) {
                    top = Math.max(viewportPadding, ownerRect.top - tooltipRect.height - 6);
                }
                tooltip.style.left = `${left}px`;
                tooltip.style.top = `${top}px`;
            };
            button.addEventListener("pointerenter", positionTooltip);
            button.addEventListener("focus", positionTooltip);
            button.addEventListener("click", () => {
                positionTooltip();
                button.focus();
            });
            button.addEventListener("keydown", (event) => {
                if (event.key === "Escape")
                    button.blur();
            });
        });
    }
    function renderPresetsPanel() {
        return `
    
      <p style="font-size:12px;color:var(--hp-text-muted);">프롬프트, 요약/검색 단위, 기억 토큰·비율, 구분자, 출력 포맷을 함께 저장합니다.</p>
      <div class="hp-row" style="align-items:stretch;">
        <select class="hp-select" id="hp-preset-select" aria-label="현재 프리셋" style="min-width:200px;flex:1;"><option value="">저장된 프리셋 없음</option></select>

      </div>
      <div class="hp-row" style="gap:6px;flex-wrap:wrap;">
        <button class="hp-btn secondary" id="hp-rename-current-preset">이름 수정</button>
        <button class="hp-btn secondary" id="hp-copy-current-preset">복사</button>
        <button class="hp-btn secondary" id="hp-add-preset">추가</button>
        <button class="hp-btn secondary" id="hp-import-preset">불러오기</button>
        <button class="hp-btn danger" id="hp-delete-current-preset">삭제</button>
        <input type="file" id="hp-import-file" accept=".json" hidden>
      </div>
      <p style="margin:4px 0 0;font-size:11px;color:var(--hp-text-muted);">* 불러오기 = 하이파에서 불러오기</p>
    `;
    }
    // ── Panel: Regex ─────────────────────────────────────────────────────────
    function renderRegexPanel() {
        const draft = getRegexSettingsDraft();
        const chatIds = new Set(draft.ids);
        const cards = draft.rules.length === 0
            ? `<div class="hp-empty">저장된 정규식이 없습니다.</div>`
            : draft.rules.map((rule) => {
                const expanded = expandedRegexRuleIds.has(rule.id);
                return `
      <div class="hp-card hp-regex-rule" data-regex-rule-id="${escapeHtml(rule.id)}">
        <div class="hp-regex-rule-summary">
          <label class="hp-regex-header-enabled" title="사용" aria-label="${escapeHtml(rule.name || "정규식")} 사용">
            <input type="checkbox" class="hp-regex-enabled" ${rule.enabled ? "checked" : ""}>
          </label>
          <button type="button" class="hp-regex-open" aria-expanded="${expanded}">
            <span class="hp-regex-open-name">${escapeHtml(rule.name || "정규식")}</span>
          </button>
          <button type="button" class="hp-regex-delete-rule" aria-label="${escapeHtml(rule.name || "정규식")} 삭제" title="삭제"><span class="material-symbols-outlined" aria-hidden="true">close</span></button>
        </div>
        ${expanded ? `
        <div class="hp-regex-editor">
          <div class="hp-regex-rule-header">
            <div class="hp-regex-scope-options" aria-label="사용 범위">
              <label class="hp-regex-check"><input type="checkbox" class="hp-regex-global" ${rule.globalEnabled ? "checked" : ""}><span>공용</span></label>
              <label class="hp-regex-check"><input type="checkbox" class="hp-regex-chat" ${chatIds.has(rule.id) ? "checked" : ""}><span>현재 채팅</span></label>
            </div>
          </div>
          <div class="hp-regex-io-grid">
            <label class="hp-field"><span class="hp-field-label hp-label-with-help">IN ${renderSettingsHelp("찾을 패턴")}</span><textarea class="hp-textarea hp-regex-pattern" spellcheck="false">${escapeTextareaValue(rule.pattern)}</textarea></label>
            <label class="hp-field"><span class="hp-field-label hp-label-with-help">OUT ${renderSettingsHelp("바꿀 문자열")}</span><textarea class="hp-textarea hp-regex-replacement" spellcheck="false">${escapeTextareaValue(rule.replacement)}</textarea></label>
          </div>
          <div class="hp-regex-rule-footer">
            <div class="hp-regex-targets"><span class="hp-regex-targets-title">용도</span>
              <label class="hp-regex-check"><input type="checkbox" class="hp-regex-target-summary" ${rule.targets.summarySource ? "checked" : ""}><span>요약 원문</span></label>
              <label class="hp-regex-check"><input type="checkbox" class="hp-regex-target-query" ${rule.targets.chatQuery ? "checked" : ""}><span>Chat query</span></label>
              <label class="hp-regex-check"><input type="checkbox" class="hp-regex-target-memory" ${rule.targets.memoryEmbedding ? "checked" : ""}><span>Memory embedding</span></label>
            </div>
            <label class="hp-field hp-regex-flags-field"><span class="hp-field-label">Flags</span><input class="hp-input hp-regex-flags" value="${escapeHtml(rule.flags)}" spellcheck="false"></label>

          </div>
        </div>` : ""}
      </div>`;
            }).join("");
        return `
      <div class="hp-regex-stack">${cards}</div>
      <div class="hp-card"><div class="hp-regex-toolbar">
        <button class="hp-btn primary" id="hp-regex-add-rule">+ 직접 추가</button>
        <button class="hp-btn secondary" id="hp-regex-import-character">Risu 캐릭터에서 가져오기</button>
        <input type="file" id="hp-regex-import-file" accept=".json" style="display:none;">
        <button class="hp-btn secondary" id="hp-regex-import-json">Risu JSON 가져오기</button>
        <span class="hp-regex-count">총 ${draft.rules.length}개</span>
      </div></div>`;
    }
    // ── Panel: Prompt ────────────────────────────────────────────────────────
    function escapeTextareaValue(value) {
        const escaped = escapeHtml(value);
        // HTML strips exactly one leading newline from textarea raw text.
        // Add one only for serialization so the stored value round-trips unchanged.
        return /^\r?\n/.test(value) ? `\n${escaped}` : escaped;
    }
    /**
     * Injection text accepts both literal line breaks entered in the textarea
     * and familiar escape notation such as "\\n". Storage/UI keep the user's
     * original spelling; decoding happens only at the point of actual use.
     */
    function resolveInjectionText(value) {
        return String(value ?? "")
            .replace(/\\r\\n/g, "\n")
            .replace(/\\n/g, "\n")
            .replace(/\\r/g, "\r")
            .replace(/\\t/g, "\t");
    }
    function renderNodeContentEditor(prefix, content) {
        return `
      <div class="hp-row hp-node-content-row">
        ${prefix === "edit" ? `<div class="hp-node-content-toolbar" aria-label="내용 편집 도구">
          <button class="hp-btn secondary small icon-only hp-editor-tool hp-history-icon-btn" type="button" id="hp-${prefix}-undo" aria-label="실행 취소" title="실행 취소"><svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path d="M18 13C17.4904 11.9961 16.6247 11.1655 15.5334 10.6333C14.442 10.1011 13.1842 9.89624 11.9494 10.0495C9.93127 10.3 8.52468 11.6116 7 12.8186M7 10V13H10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
          <button class="hp-btn secondary small icon-only hp-editor-tool hp-history-icon-btn" type="button" id="hp-${prefix}-redo" aria-label="재실행" title="재실행"><svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path d="M6 13C6.50963 11.9961 7.37532 11.1655 8.46665 10.6333C9.55797 10.1011 10.8158 9.89624 12.0506 10.0495C14.0687 10.3 15.4753 11.6116 17 12.8186M17 10V13H14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        </div>` : ""}
        ${prefix === "edit" ? `<div class="hp-node-editor-indexes" aria-label="노드 편집 보기">
          <span class="hp-node-editor-mode active">원문</span>
        </div>` : ""}
        <textarea class="hp-textarea hp-node-content-editor" id="hp-${prefix}-content">${escapeHtml(content)}</textarea>
      </div>`;
    }
    function parseLinkedMessageIndexes(value) {
        const normalized = String(value ?? "").trim();
        if (!normalized)
            return [];
        const result = new Set();
        const parts = normalized.replace(/#/g, "").split(/[\s,;]+/).filter(Boolean);
        for (const part of parts) {
            const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
            if (range) {
                const start = Number(range[1]);
                const end = Number(range[2]);
                if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || end - start > 10000)
                    return null;
                for (let index = start; index <= end; index += 1)
                    result.add(index);
                continue;
            }
            if (!/^\d+$/.test(part))
                return null;
            const index = Number(part);
            if (!Number.isSafeInteger(index))
                return null;
            result.add(index);
        }
        return [...result].sort((a, b) => a - b);
    }
    function updateCreateMetadataSummary() {
        const category = document.getElementById("hp-create-category")?.value.trim() ?? "";
        const tags = document.getElementById("hp-create-tags")?.value
            .split(",").map(tag => tag.trim()).filter(Boolean) ?? [];
        const strip = document.getElementById("hp-create-tag-strip");
        if (!strip)
            return;
        strip.innerHTML = `${category ? `<span class="hp-proto-chip hp-proto-category" title="${escapeHtml(category)}">${escapeHtml(category)}</span>` : ""}${tags.map(tag => `<span class="hp-proto-chip hp-proto-tag" title="${escapeHtml(tag)}">${escapeHtml(tag)}</span>`).join("")}`;
    }
    function showCreateMemoryMetadataDialog() {
        if (document.querySelector(".hp-create-metadata-dialog"))
            return;
        const categoryStore = document.getElementById("hp-create-category");
        const tagsStore = document.getElementById("hp-create-tags");
        if (!categoryStore || !tagsStore)
            return;
        const overlay = document.createElement("div");
        overlay.className = "hp-edit-overlay";
        overlay.innerHTML = `<form class="hp-edit-box hp-metadata-dialog hp-create-metadata-dialog" role="dialog" aria-modal="true" aria-labelledby="hp-create-metadata-title">
      <h3 id="hp-create-metadata-title">태그·분류</h3>
      <label><span>분류</span><input class="hp-input" name="category" value="${escapeHtml(categoryStore.value)}" autocomplete="off"></label>
      <label><span>태그 (쉼표로 구분)</span><textarea class="hp-textarea" name="tags" rows="3">${escapeHtml(tagsStore.value)}</textarea></label>
      <div style="display:flex;justify-content:flex-end;gap:8px"><button class="hp-btn secondary" type="button" data-cancel>취소</button><button class="hp-btn hp-popup-save-action" type="submit">등록</button></div>
    </form>`;
        document.body.appendChild(overlay);
        const form = overlay.querySelector("form");
        const category = form.elements.namedItem("category");
        const tags = form.elements.namedItem("tags");
        const close = () => {
            overlay.remove();
            document.getElementById("hp-create-metadata")?.focus();
        };
        form.querySelector("[data-cancel]").addEventListener("click", close);
        form.addEventListener("submit", event => {
            event.preventDefault();
            categoryStore.value = category.value.trim();
            tagsStore.value = [...new Set(tags.value.split(",").map(tag => tag.trim()).filter(Boolean))].join(", ");
            updateCreateMetadataSummary();
            close();
        });
        form.addEventListener("keydown", event => {
            if (event.key === "Escape") {
                event.preventDefault();
                close();
            }
        });
        category.focus();
    }
    // ── Create Node Overlay ──────────────────────────────────────────────────
    function renderCreateNodeOverlay() {
        const now = nowTimeString();
        const displayNumber = getNodes().length + 1;
        return `
    <div class="hp-edit-overlay hp-node-edit-overlay" id="hp-create-overlay">
      <div class="hp-edit-box hp-node-edit-box hp-node-create-box">
        <div class="hp-node-editor-header hp-node-create-header">
          <h3><span class="hp-node-create-number">#${displayNumber}</span><span>기억 추가</span></h3>
          <input class="hp-node-editor-time-title" id="hp-create-time" value="${escapeHtml(now)}" aria-label="시간" title="터치하여 시간 수정">
        </div>
        <div class="hp-node-edit-form">
          <input type="hidden" id="hp-create-tags" value="">
          <input type="hidden" id="hp-create-category" value="">
          <div class="hp-node-create-actions">
            <span class="hp-card-inline-history"><button class="hp-btn secondary small icon-only hp-history-icon-btn" type="button" id="hp-create-undo" aria-label="실행 취소" title="실행 취소"><svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path d="M18 13C17.4904 11.9961 16.6247 11.1655 15.5334 10.6333C14.442 10.1011 13.1842 9.89624 11.9494 10.0495C9.93127 10.3 8.52468 11.6116 7 12.8186M7 10V13H10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button><button class="hp-btn secondary small icon-only hp-history-icon-btn" type="button" id="hp-create-redo" aria-label="재실행" title="재실행"><svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path d="M6 13C6.50963 11.9961 7.37532 11.1655 8.46665 10.6333C9.55797 10.1011 10.8158 9.89624 12.0506 10.0495C14.0687 10.3 15.4753 11.6116 17 12.8186M17 10V13H14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button></span>
            ${renderMemoryMetadataButton({ id: "create", time: now, content: "", createdAt: 0 }).replace(/data-node-id="create"/g, `id="hp-create-metadata" data-node-id="create"`)}
            <span class="hp-node-tag-strip" id="hp-create-tag-strip"></span>
          </div>
          <div class="hp-card-inline-meta">
            <label class="hp-card-inline-meta-field">
              <span class="hp-field-label">활성 키</span>
              <input class="hp-card-inline-meta-input" id="hp-create-activation-cues" placeholder="쉼표로 구분">
            </label>
          </div>
          ${renderNodeContentEditor("create", "")}
          <label class="hp-field hp-node-create-links">
            <span class="hp-field-label">연결 메시지 인덱스 <span class="hp-field-hint">(선택)</span></span>
            <input class="hp-input" id="hp-create-linked-messages" placeholder="예: 5, 8-11, #14" inputmode="numeric">
          </label>
          <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end;flex:0 0 auto;">
            <button class="hp-btn secondary" id="hp-create-cancel">취소</button>
            <button class="hp-btn hp-popup-save-action" id="hp-create-save"> 저장</button>
          </div>
        </div>
      </div>
    </div>`;
    }
    // ── Summarize Dialog ─────────────────────────────────────────────────────
    function renderSummarizeDialog(pendingMessages) {
        const totalPending = pendingMessages.length;
        const maxChunks = Math.max(1, Math.floor(totalPending / chunkSize));
        const defaultChunks = Math.min(1, maxChunks);
        const window = pendingMessages.slice(0, chunkSize);
        const displayPending = includeUserMessages ? window : window.filter((m) => m.role !== "user");
        const previewCount = displayPending.length;
        let previewHtml = "";
        for (let i = 0; i < previewCount; i++) {
            const msg = displayPending[i];
            const pendingIndex = pendingMessages.indexOf(msg);
            const startIndex = getLastSummarizedMsgIndex() + 1;
            const messageIndex = startIndex <= 0 ? pendingIndex - 1 : startIndex + pendingIndex;
            const preview = msg.content.length > 150 ? msg.content.slice(0, 150) + "..." : msg.content;
            previewHtml += `<div class="hp-summarize-pending-message" role="button" tabindex="0" data-pending-index="${pendingIndex}" data-message-index="${messageIndex}" title="클릭하여 원문 메시지 보기" style="padding:4px 0;border-bottom:var(--hp-border-width) solid var(--hp-border);font-size:12px;cursor:pointer;">
        <span style="color:var(--hp-text-strong);">[${messageIndex}]</span> ${escapeHtml(preview)}
      </div>`;
        }
        return `
    <div class="hp-edit-overlay" id="hp-summarize-overlay">
      <div class="hp-edit-box" style="max-width:700px;">
        <h3> 수동 메시지 요약</h3>
        <p style="font-size:13px;color:var(--hp-text-muted);">미요약 메시지 ${totalPending}개 (${chunkSize}개 메시지가 포함된 청크 ${maxChunks}개를 만들 수 있습니다).</p>
        <div class="hp-row">
          <span class="hp-label">요약할 청크 수</span>
          <input class="hp-input" type="number" id="hp-summarize-chunks" value="${defaultChunks}" min="1" max="${maxChunks}" style="width:100px;">
          <span style="font-size:12px;color:var(--hp-text-muted);">/ ${maxChunks} 청크 (각 메시지 ${chunkSize}개)</span>
        </div>
        <div style="margin:8px 0;">
          <strong style="font-size:13px;"> 미리보기 (총 ${totalPending} 개 중 ${previewCount} 개)</strong>
          <div style="max-height:300px;overflow-y:auto;margin-top:4px;background:var(--hp-inset);padding:8px;border-radius:var(--hp-radius-sm);">
            ${previewHtml}
          </div>
        </div>
        <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end;">
          <button class="hp-btn secondary" id="hp-summarize-cancel">취소</button>
          <button class="hp-btn hp-action-manual-summary" id="hp-summarize-confirm"> 요약</button>
        </div>
      </div>
    </div>`;
    }
    /** Shared viewer used by chunk messages and single pending-message previews. */
    function showMessageViewer(title, msgText) {
        const overlay = document.createElement("div");
        overlay.className = "hp-edit-overlay";
        overlay.innerHTML = `
      <div class="hp-edit-box" style="max-width:800px;">
        <h3>${escapeHtml(title)}</h3>
        <pre class="hp-message-view-content" style="background:var(--hp-inset);padding:12px;border-radius:var(--hp-radius-sm);font-size:13px;max-height:70vh;overflow:auto;white-space:pre-wrap;">${escapeHtml(msgText)}</pre>
        <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end;">
          <button class="hp-btn secondary hp-message-view-close">Close</button>
        </div>
      </div>
    `;
        document.body.appendChild(overlay);
        overlay.querySelector(".hp-message-view-close").addEventListener("click", () => {
            overlay.remove();
        });
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay)
                overlay.remove();
        });
    }
    async function loadChunkViewerData(entry) {
        const raw = await readEntryMessages(entry);
        let messages = raw.map(message => ({ ...message, cacheContent: message.content,
            cacheKey: message.chatId, displayIdx: message.index }));
        if (!messages.length)
            return null;
        messages = applyRegexToMessages(messages);
        return { title: `연결된 메시지 (${messages.length}) ${formatEntryMessageRange(entry)}`, messages };
    }
    function cleanChunkMessageDisplay(text) {
        return text
            .replace(/<\s*(?:Thoughts|think)\b[^>]*>[\s\S]*?<\s*\/\s*(?:Thoughts|think)\s*>/gi, "")
            .replace(/<!--[\s\S]*?-->/g, "")
            .replace(/<\s*br\s*\/?>/gi, "\n")
            .replace(/<\/?[A-Za-z][^>]*>/g, "")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }
    function extractLongestTranslationCacheChunk(text) {
        const chunks = text
            .split(/\[.*?\]|<[^>]*>|\{\{.*?\}\}/gs)
            .map((chunk) => chunk.trim())
            .filter((chunk) => chunk.length > 30)
            .sort((a, b) => b.length - a.length);
        return chunks[0] ?? "";
    }
    async function findCachedTranslation(originalText) {
        try {
            const exact = await risuai.getTranslationCache(originalText);
            if (typeof exact === "string" && exact.trim())
                return exact;
            const chunk = extractLongestTranslationCacheChunk(originalText);
            if (!chunk)
                return null;
            const entries = await risuai.searchTranslationCache(chunk);
            if (!Array.isArray(entries))
                return null;
            const minLength = originalText.length * 0.5;
            const maxLength = originalText.length * 1.5;
            const matches = entries.filter((entry) => entry &&
                typeof entry.key === "string" &&
                typeof entry.value === "string" &&
                entry.key.length >= minLength &&
                entry.key.length <= maxLength);
            matches.sort((a, b) => Math.abs(a.key.length - originalText.length) - Math.abs(b.key.length - originalText.length));
            return matches[0]?.value ?? null;
        }
        catch (error) {
            console.log("[Hypirk] Translation cache lookup failed:", error);
            return null;
        }
    }
    async function resolveStoredTranslationCache(message, forceRefresh = false) {
        const sourceHash = await hashMessageContent(message.cacheContent);
        const cache = state.translationViewCache ?? (state.translationViewCache = {});
        const stored = cache[message.cacheKey];
        if (!forceRefresh && stored?.sourceHash === sourceHash) {
            return { value: stored.value, reused: true };
        }
        const rawValue = await findCachedTranslation(message.cacheContent);
        const value = rawValue ? cleanChunkMessageDisplay(rawValue) || null : null;
        cache[message.cacheKey] = { sourceHash, value, checkedAt: Date.now() };
        markDerivedCacheDirty();
        return { value, reused: false };
    }
    function mountChunkMessageViewer(root, title, messages, inline = false, onClose, onResummarize) {
        const originalText = messages
            .map((message) => `#${message.displayIdx} ${message.role === "user" ? "user" : "char"} ---\n${cleanChunkMessageDisplay(message.content)}`)
            .join("\n\n");
        root.innerHTML = `
      <div class="${inline ? "hp-inline-message-viewer" : "hp-edit-box"}"${inline ? "" : ' style="max-width:800px;"'}>
        ${inline ? "" : `<h3>${escapeHtml(title)}</h3>`}
        <div class="hp-message-view-tabs" role="tablist">
          <button class="hp-message-view-tab active" data-view="original" role="tab" aria-selected="true">원문</button>
          <button class="hp-message-view-tab" data-view="translation" role="tab" aria-selected="false">번역문</button>
          <span class="hp-message-cache-status"></span>
          <button class="hp-btn secondary small hp-message-cache-refresh" type="button" hidden>캐시 새로고침</button>
        </div>
        <pre class="hp-message-view-content" style="background:var(--hp-inset);padding:12px;border-radius:var(--hp-radius-sm);font-size:13px;max-height:70vh;overflow:auto;white-space:pre-wrap;">${escapeHtml(originalText)}</pre>
        <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end;">
          ${onResummarize ? `<button class="hp-btn secondary hp-message-view-resummarize" type="button">재요약</button>` : ""}
          <button class="hp-btn secondary hp-message-view-close">닫기</button>
        </div>
      </div>`;
        const content = root.querySelector(".hp-message-view-content");
        const status = root.querySelector(".hp-message-cache-status");
        const refreshButton = root.querySelector(".hp-message-cache-refresh");
        const tabs = Array.from(root.querySelectorAll(".hp-message-view-tab"));
        let translatedText = null;
        let loadingPromise = null;
        let currentView = "original";
        const loadTranslationView = async (forceRefresh = false) => {
            status.textContent = forceRefresh ? "번역 캐시 새로고침 중…" : "번역 캐시 불러오는 중…";
            const results = await Promise.all(messages.map((message) => resolveStoredTranslationCache(message, forceRefresh)));
            await saveState();
            const hitCount = results.filter((result) => Boolean(result.value)).length;
            const reusedCount = results.filter((result) => result.reused).length;
            translatedText = messages
                .map((message, index) => {
                const header = `#${message.displayIdx} ${message.role === "user" ? "user" : "char"} ---`;
                const translation = results[index].value;
                return translation
                    ? `${header}\n${cleanChunkMessageDisplay(translation)}`
                    : `${header} ⚠ 캐시 없음 (원문)\n${cleanChunkMessageDisplay(message.cacheContent)}`;
            })
                .join("\n\n");
            status.textContent = `캐시 ${hitCount}/${messages.length}${reusedCount ? ` · 저장본 ${reusedCount}` : ""}`;
        };
        const activate = async (view, forceRefresh = false) => {
            currentView = view;
            refreshButton.hidden = view !== "translation";
            tabs.forEach((tab) => {
                const active = tab.dataset.view === view;
                tab.classList.toggle("active", active);
                tab.setAttribute("aria-selected", String(active));
            });
            if (view === "original") {
                content.textContent = originalText;
                return;
            }
            if (!translatedText || forceRefresh) {
                if (!loadingPromise) {
                    loadingPromise = loadTranslationView(forceRefresh);
                }
                await loadingPromise;
            }
            if (root.isConnected && translatedText && currentView === "translation") {
                content.textContent = translatedText;
            }
        };
        tabs.forEach((tab) => {
            tab.addEventListener("click", () => void activate(tab.dataset.view === "translation" ? "translation" : "original"));
        });
        refreshButton.addEventListener("click", () => {
            translatedText = null;
            loadingPromise = null;
            void activate("translation", true);
        });
        const resummarizeButton = root.querySelector(".hp-message-view-resummarize");
        resummarizeButton?.addEventListener("click", () => {
            if (!onResummarize)
                return;
            resummarizeButton.disabled = true;
            void onResummarize().finally(() => {
                if (resummarizeButton.isConnected)
                    resummarizeButton.disabled = false;
            });
        });
        root.querySelector(".hp-message-view-close").addEventListener("click", () => onClose?.());
    }
    function showTextInputDialog(title, initialValue, placeholder) {
        return new Promise((resolve) => {
            const overlay = document.createElement("div");
            overlay.className = "hp-edit-overlay";
            overlay.innerHTML = `
        <div class="hp-edit-box" style="max-width:450px;">
          <h3 style="margin-top:0;">${escapeHtml(title)}</h3>
          <input class="hp-input" id="hp-text-input-dialog-value" type="text" value="${escapeHtml(initialValue)}" placeholder="${escapeHtml(placeholder)}" style="width:100%;box-sizing:border-box;">
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
            <button class="hp-btn primary" id="hp-text-input-dialog-save">저장</button>
            <button class="hp-btn secondary" id="hp-text-input-dialog-cancel">취소</button>
          </div>
        </div>
      `;
            const input = overlay.querySelector("#hp-text-input-dialog-value");
            let settled = false;
            const finish = (value) => {
                if (settled)
                    return;
                settled = true;
                overlay.remove();
                resolve(value);
            };
            document.body.appendChild(overlay);
            input.focus();
            input.select();
            overlay.querySelector("#hp-text-input-dialog-save").addEventListener("click", () => {
                finish(input.value);
            });
            overlay.querySelector("#hp-text-input-dialog-cancel").addEventListener("click", () => {
                finish(null);
            });
            input.addEventListener("keydown", (event) => {
                if (event.key === "Enter") {
                    event.preventDefault();
                    finish(input.value);
                }
                else if (event.key === "Escape") {
                    event.preventDefault();
                    finish(null);
                }
            });
            overlay.addEventListener("click", (event) => {
                if (event.target === overlay)
                    finish(null);
            });
        });
    }
    function moveEntryMessages(from, to, slots) {
        if (from === to)
            return;
        const moving = new Set(slots.filter(slot => from.linkedMessages.includes(slot)));
        from.linkedMessages = from.linkedMessages.filter(slot => !moving.has(slot));
        to.linkedMessages = [...new Set([...to.linkedMessages, ...moving])];
    }
    async function showMemoryEntryEditor() {
        if (isSummarizing) {
            alert("요약 완료 후 엔트리를 편집해주세요.");
            return;
        }
        const raw = await readChatMessagesRaw();
        const first = await fetchFirstMessage();
        const available = first ? [{ ...first, chatId: FIRST_MESSAGE_CHAT_ID, index: -1 }, ...raw] : raw;
        const overlay = document.createElement("div");
        overlay.className = "hp-edit-overlay";
        overlay.innerHTML = `<div class="hp-edit-box" style="width:min(900px,96vw);max-height:90vh;overflow:auto;" role="dialog" aria-modal="true" aria-label="엔트리 편집">
      <div style="display:flex;justify-content:space-between"><h3>엔트리 편집</h3><button class="hp-btn secondary" data-close>닫기</button></div>
      <details><summary>메시지 선택 → 빈 엔트리 만들기</summary><div style="max-height:240px;overflow:auto" data-selection></div>
      <button class="hp-btn" data-create>선택한 메시지로 빈 엔트리 생성</button></details><div data-entries></div></div>`;
        document.body.appendChild(overlay);
        const selection = overlay.querySelector("[data-selection]");
        selection.innerHTML = available.map(message => `<label style="display:block"><input type="checkbox" value="${message.index}"> #${message.index} ${escapeHtml(message.role)} ${escapeHtml(message.content.slice(0, 100))}</label>`).join("");
        const list = overlay.querySelector("[data-entries]");
        const render = () => {
            list.innerHTML = state.entries.map((entry, position) => `<section class="hp-card" data-position="${position}">
        <strong>${entry.memory ? `기억 #${memoryDisplayNumber(entry.memory)}` : "빈 엔트리"}</strong>
        <details data-message-list><summary>연결 메시지 ${escapeHtml(formatEntryMessageRange(entry))} (${entry.linkedMessages.length})</summary>
        ${entry.linkedMessages.map(slot => {
                const record = state.messages[String(slot)];
                const message = available.find(message => message.chatId === record?.chatId);
                return `<div data-move-slot="${slot}" style="padding:8px;border:1px solid var(--hp-border);margin:4px 0;user-select:none;touch-action:none" title="길게 눌러 다른 엔트리로 이동">#${message?.index ?? "?"} ${escapeHtml(message?.content.slice(0, 100) ?? "연결되지 않은 메시지")}</div>`;
            }).join("")}</details>
        <label>현재 메시지 번호 (예: 120-122, 125)<input class="hp-input" data-range value="${getEntryMessageIndices(entry).join(", ")}"></label>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
          <button class="hp-btn secondary" data-links>연결 변경</button><button class="hp-btn secondary" data-duplicate>같은 연결로 빈 엔트리</button>
          ${entry.memory ? "" : '<button class="hp-btn" data-write>기억 작성</button>'}<button class="hp-btn danger" data-delete>엔트리 삭제</button></div></section>
`).join("");
        };
        render();
        let drag = null;
        let holdTimer = null;
        const cancel = () => { if (holdTimer)
            clearTimeout(holdTimer); holdTimer = null; drag = null; };
        list.addEventListener("pointerdown", event => {
            const target = event.target;
            const row = target.closest("[data-move-slot]");
            if (!row)
                return;
            const position = Number(row.closest("[data-position]").dataset.position);
            drag = { from: state.entries[position], slot: Number(row.dataset.moveSlot), active: false, x: event.clientX, y: event.clientY };
            list.setPointerCapture(event.pointerId);
            holdTimer = setTimeout(() => { if (drag) {
                drag.active = true;
                row.style.opacity = ".5";
            } }, 350);
        });
        list.addEventListener("pointermove", event => {
            if (drag) {
                drag.x = event.clientX;
                drag.y = event.clientY;
                if (drag.active)
                    event.preventDefault();
            }
        });
        list.addEventListener("pointercancel", () => { cancel(); render(); });
        list.addEventListener("pointerup", event => {
            if (!drag)
                return;
            void (async () => {
                if (drag?.active) {
                    const row = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-position]");
                    const to = row ? state.entries[Number(row.dataset.position)] : undefined;
                    if (to)
                        moveEntryMessages(drag.from, to, [drag.slot]);
                }
                else {
                    cancel();
                    render();
                    return;
                }
                cancel();
                await saveState();
                invalidateUiSessionRenderData();
                render();
            })().catch(error => { cancel(); alert(String(error)); });
        });
        overlay.addEventListener("click", event => {
            void (async () => {
                const target = event.target.closest("button");
                if (!target)
                    return;
                if (target.hasAttribute("data-close")) {
                    cancel();
                    overlay.remove();
                    await renderUI(true);
                    return;
                }
                if (target.hasAttribute("data-create")) {
                    const indices = new Set(Array.from(selection.querySelectorAll("input:checked")).map(input => Number(input.value)));
                    if (!indices.size) {
                        alert("메시지를 선택해주세요.");
                        return;
                    }
                    appendMemoryEntry(null, await registerMessages(available.filter(message => indices.has(message.index))));
                }
                else {
                    const row = target.closest("[data-position]");
                    const entry = row ? state.entries[Number(row.dataset.position)] : undefined;
                    if (!entry || !row)
                        return;
                    if (target.hasAttribute("data-delete")) {
                        if (!await showConfirmDialog("이 엔트리만 삭제할까요?"))
                            return;
                        if (entry.memory)
                            removeNodeById(entry.memory.id);
                        else
                            state.entries.splice(state.entries.indexOf(entry), 1);
                    }
                    else if (target.hasAttribute("data-duplicate"))
                        appendMemoryEntry(null, entry.linkedMessages);
                    else if (target.hasAttribute("data-write")) {
                        entry.memory = { id: nextNodeId(), time: "", content: "", createdAt: Date.now() };
                        await saveState();
                        overlay.remove();
                        await renderUI(true);
                        return;
                    }
                    else if (target.hasAttribute("data-links")) {
                        const text = row.querySelector("[data-range]").value.trim();
                        const indices = new Set();
                        for (const part of text ? text.split(",") : []) {
                            const match = part.trim().match(/^(-?\d+)(?:\s*-\s*(-?\d+))?$/);
                            if (!match)
                                throw new Error("메시지 번호 형식이 올바르지 않습니다.");
                            const start = Number(match[1]), end = match[2] === undefined ? start : Number(match[2]);
                            if (start < -1 || end < start || end - start > available.length)
                                throw new Error("메시지 범위를 확인해주세요.");
                            for (let index = start; index <= end; index++)
                                indices.add(index);
                        }
                        const selected = available.filter(message => indices.has(message.index));
                        if (selected.length !== indices.size)
                            throw new Error("현재 채팅에 없는 메시지 번호입니다.");
                        entry.linkedMessages = await registerMessages(selected);
                    }
                    else
                        return;
                }
                await saveState();
                invalidateUiSessionRenderData();
                render();
            })().catch(error => alert(String(error)));
        });
    }
    function showEmbeddingTraceDialog(nodeId) {
        const trace = lastEmbeddingRetrievalTrace;
        const nodeTrace = trace?.nodes[nodeId];
        if (!trace || !nodeTrace)
            return false;
        document.querySelector(".hp-embedding-trace-overlay")?.remove();
        const scores = state.lastNodeScores?.[nodeId];
        const node = getNodes().find((memory) => memory.id === nodeId);
        const createdAt = new Date(trace.createdAt).toLocaleString();
        const queryGroups = new Map();
        for (const source of trace.sources ?? []) {
            const key = source.sourceMessageIndex === undefined
                ? `fallback:${source.sourceRole ?? "unknown"}`
                : `message:${source.sourceMessageIndex}:${source.sourceRole ?? "unknown"}`;
            queryGroups.set(key, { source, queries: [] });
        }
        trace.queries.forEach((query, queryIndex) => {
            const key = query.sourceMessageIndex === undefined
                ? `fallback:${query.sourceRole ?? "unknown"}`
                : `message:${query.sourceMessageIndex}:${query.sourceRole ?? "unknown"}`;
            const group = queryGroups.get(key) ?? { source: null, queries: [] };
            group.queries.push({ query, index: queryIndex });
            queryGroups.set(key, group);
        });
        const querySourceCards = [...queryGroups.values()].map((group) => {
            const firstQuery = group.queries[0]?.query;
            const source = group.source;
            const sourceLabel = firstQuery?.sourceMessageIndex === undefined
                ? "대체 쿼리"
                : `메시지 #${firstQuery.sourceMessageIndex} · ${firstQuery.sourceRole ?? "알 수 없음"}`;
            const paragraphSummary = source
                ? `원문 ${source.originalParagraphCount}문단 → 정규식 후 ${source.processedParagraphCount}문단 → Query ${source.queryCount}개`
                : `Query ${group.queries.length}개`;
            const fragmentRows = group.queries.map(({ query, index }) => `
        <div class="hp-trace-score-row">
          <span class="hp-trace-score-query">Q${index + 1} · 가중치 ${query.weight.toFixed(4)}</span>
          <span class="hp-trace-score-text">${escapeHtml(query.text)}</span>
          <span>${query.partIndex + 1}/${query.partCount}</span>
        </div>`).join("");
            return `<div class="hp-trace-card">
        <div class="hp-trace-card-head"><span>${escapeHtml(sourceLabel)}</span><span>${escapeHtml(paragraphSummary)}</span></div>
        <div class="hp-trace-signal-detail">문단 묶음 크기 ${trace.paragraphGroupSize}</div>
        ${fragmentRows
                ? `<details open><summary style="margin-top:7px;cursor:pointer;font-size:11px;color:var(--hp-text-strong);">분리된 Query 원문 ${group.queries.length}개</summary><div style="margin-top:5px;">${fragmentRows}</div></details>`
                : `<div class="hp-trace-signal-detail">정규식 처리 후 남은 Query가 없습니다.</div>`}
      </div>`;
        }).join("");
        const scoreRows = nodeTrace.querySimilarities.map((similarity, queryIndex) => {
            const query = trace.queries[queryIndex];
            const contribution = similarity * (query?.weight ?? 0);
            return `<div class="hp-trace-score-row">
        <span class="hp-trace-score-query">Q${queryIndex + 1} ${similarity.toFixed(4)} × ${(query?.weight ?? 0).toFixed(4)}</span>
        <span class="hp-trace-score-text">${escapeHtml(query?.text ?? "")}</span>
        <span>= ${contribution.toFixed(4)}</span>
      </div>`;
        }).join("");
        const memoryTargetCard = `<div class="hp-trace-card">
      <div class="hp-trace-card-head"><span>Memory 전체 · 내용 순위 #${nodeTrace.globalRank}</span><span>점수 ${nodeTrace.embeddingScore.toFixed(4)}</span></div>
      <pre class="hp-trace-text">${escapeHtml(nodeTrace.memoryText)}</pre>
      <details open>
        <summary style="margin-top:7px;cursor:pointer;font-size:11px;color:var(--hp-text-strong);">Query별 similarity ${nodeTrace.querySimilarities.length}개</summary>
        <div style="margin-top:5px;">${scoreRows}</div>
      </details>
    </div>`;
        const contentFormula = `내용 임베딩 = Σ(Query similarity × Query weight) = ${nodeTrace.embeddingScore.toFixed(4)}`;
        const lexicalDialogueHtml = scores?.dialogueMatch
            ? `<div class="hp-trace-signal-detail">
          <div>점수 ${(scores.dialogueLocal ?? 0).toFixed(4)} × 가중치 ${dialogueLocalWeight.toFixed(2)} = <strong>+${(scores.dialogueContribution ?? 0).toFixed(4)}</strong></div>
          <div>방식: ${escapeHtml(scores.dialogueMatch.method)}</div>
          <div>현재 대사: ${escapeHtml(scores.dialogueMatch.currentDialogue)}</div>
          <div>과거 대사: ${escapeHtml(scores.dialogueMatch.storedDialogue)}</div>
          ${scores.dialogueMatch.sharedNgrams?.length ? `<div>공통 3-word n-gram: ${escapeHtml(scores.dialogueMatch.sharedNgrams.join(", "))}</div>` : ""}
        </div>`
            : `<div class="hp-trace-signal-detail">일치 없음 · 기여 +0.0000</div>`;
        const semanticDialogueHtml = scores?.dialogueEmbeddingStatus === "ok"
            ? `<div class="hp-trace-signal-detail">
          <div>점수 ${(scores.dialogueEmbedding ?? 0).toFixed(4)} × 가중치 ${dialogueEmbeddingWeight.toFixed(2)} = <strong>+${(scores.dialogueEmbeddingContribution ?? 0).toFixed(4)}</strong></div>
          <div>현재 대화 묶음 1개 · 기억 대화 묶음 ${scores.dialogueEmbeddingChildCount ?? 0}개</div>
          ${scores.dialogueEmbeddingMatch ? `<div>현재 대화 묶음:</div><pre class="hp-trace-text">${escapeHtml(scores.dialogueEmbeddingMatch.currentDialogue)}</pre><div>기억 대화 묶음:</div><pre class="hp-trace-text">${escapeHtml(scores.dialogueEmbeddingMatch.storedDialogue)}</pre>` : ""}
        </div>`
            : `<div class="hp-trace-signal-detail">상태: ${escapeHtml(scores?.dialogueEmbeddingStatus ?? "기록 없음")} · 기여 +${(scores?.dialogueEmbeddingContribution ?? 0).toFixed(4)}</div>`;
        const activationHtml = scores?.activationCueMatch
            ? `<div class="hp-trace-signal-detail">
          <div>점수 ${(scores.activationCue ?? 0).toFixed(4)} × 가중치 ${activationCueWeight.toFixed(2)} = <strong>+${(scores.activationCueContribution ?? 0).toFixed(4)}</strong></div>
          <div>활성 키: ${escapeHtml(scores.activationCueMatch.cue)}</div>
          <div>매칭 방식: ${escapeHtml(scores.activationCueMatch.method)} · 원점수 ${(scores.activationCueMatch.score ?? 0).toFixed(4)}</div>
          <div>매칭 대상: ${escapeHtml(scores.activationCueMatch.queryText)}</div>
        </div>`
            : `<div class="hp-trace-signal-detail">일치 없음 · 기여 +0.0000</div>`;
        const likeRemaining = node ? getLikeRemaining(node, trace.createdAt) : 0;
        const likeHtml = node?.likedAt
            ? `<div class="hp-trace-signal-detail">
          <div>기본 보너스 ${likeBonusBase.toFixed(4)} × 잔여 가중치 ${likeRemaining.toFixed(4)} = <strong>+${(scores?.likeBonus ?? 0).toFixed(4)}</strong></div>
          <div>좋아요 시각: ${escapeHtml(new Date(node.likedAt).toLocaleString())}</div>
          <div>감쇠: 4일 선형 · 현재 ${(likeRemaining * 100).toFixed(1)}% 남음</div>
        </div>`
            : `<div class="hp-trace-signal-detail">좋아요 없음 · 기여 +${(scores?.likeBonus ?? 0).toFixed(4)}</div>`;
        const combinedFormula = scores
            ? `최종 합산 = 내용 ${scores.similarity.toFixed(4)} + 어휘 대사 ${(scores.dialogueContribution ?? 0).toFixed(4)} + 의미 대사 ${(scores.dialogueEmbeddingContribution ?? 0).toFixed(4)} + 활성 키 ${(scores.activationCueContribution ?? 0).toFixed(4)} + 좋아요 ${(scores.likeBonus ?? 0).toFixed(4)} = ${scores.combined.toFixed(4)}`
            : "";
        const history = compactRetrievalHistoryForNode(nodeId);
        const historyHtml = history.map((entry) => {
            const sourceLabel = entry.source === "R" ? "Recent" : "Similar";
            const rankLabel = entry.rank == null ? "" : ` · #${entry.rank}`;
            const selectedLabel = entry.selected ? " · 선택됨" : "";
            const calendarLabel = entry.calendarAgeDays == null ? ""
                : ` · Calendar ${entry.calendarAgeDays === 0 ? "오늘" : entry.calendarAgeDays > 0 ? `${entry.calendarAgeDays}일 전` : `${Math.abs(entry.calendarAgeDays)}일 후`}`;
            const scoreText = entry.source === "R"
                ? `Query ${entry.queryCount}개 · 검색 점수 없음 (Recent 선발)`
                : `Q ${entry.queryCount} · 내용(C) ${(entry.content ?? 0).toFixed(3)} · 의미 대사(D) ${(entry.dialogueSemantic ?? 0).toFixed(3)} (+${(entry.dialogueSemanticContribution ?? 0).toFixed(3)}) · 어휘 대사(L) ${(entry.dialogueLexical ?? 0).toFixed(3)} (+${(entry.dialogueLexicalContribution ?? 0).toFixed(3)}) · 활성 키(A) ${(entry.activation ?? 0).toFixed(3)} (+${(entry.activationContribution ?? 0).toFixed(3)}) · 좋아요 +${(entry.likeBonus ?? 0).toFixed(3)}`;
            const totalText = entry.total == null ? "" : `= ${entry.total.toFixed(4)}`;
            return `<div class="hp-trace-score-row">
        <span>${escapeHtml(new Date(entry.at).toLocaleString())} · ${sourceLabel}${rankLabel}${selectedLabel}${calendarLabel}</span>
        <span class="hp-trace-score-text">${escapeHtml(scoreText)}</span>
        <span>${escapeHtml(totalText)}</span>
      </div>`;
        }).join("");
        const overlay = document.createElement("div");
        overlay.className = "hp-edit-overlay hp-embedding-trace-overlay";
        overlay.innerHTML = `<div class="hp-edit-box hp-trace-box" role="dialog" aria-modal="true" aria-label="기억 ${node ? memoryDisplayNumber(node) : "?"} 검색 추적">
      <div class="hp-trace-header"><h3>기억 #${node ? memoryDisplayNumber(node) : "?"} 검색 추적</h3><button class="hp-btn secondary small hp-trace-close" type="button">닫기</button></div>
      <div class="hp-trace-summary">
        <div>검색 시각: ${escapeHtml(createdAt)} · 내용 검색: Query Separate / Memory 단일 벡터 · 문단 묶음 ${trace.paragraphGroupSize}</div>
        ${combinedFormula ? `<div class="hp-trace-formula">${escapeHtml(combinedFormula)}</div>` : ""}
      </div>

      <h4 class="hp-trace-section-title">Query Separate · 원문 분절</h4>
      ${querySourceCards || `<div class="hp-empty">기록된 Query 원문이 없습니다.</div>`}

      <h4 class="hp-trace-section-title">내용 (Content)</h4>
      <div class="hp-trace-summary"><div class="hp-trace-formula">${escapeHtml(contentFormula)}</div></div>
      ${memoryTargetCard}

      <h4 class="hp-trace-section-title">어휘 대사 (Lexical Dialogue)</h4>
      <div class="hp-trace-card">${lexicalDialogueHtml}</div>

      <h4 class="hp-trace-section-title">의미 대사 (Semantic Dialogue)</h4>
      <div class="hp-trace-card">${semanticDialogueHtml}</div>

      <h4 class="hp-trace-section-title">활성 키</h4>
      <div class="hp-trace-card">${activationHtml}</div>

      <h4 class="hp-trace-section-title">좋아요</h4>
      <div class="hp-trace-card">${likeHtml}</div>

      <h4 class="hp-trace-section-title">검색 이력 (Retrieval History) · 최근 ${history.length}회</h4>
      ${historyHtml || `<div class="hp-empty">아직 누적된 검색 이력이 없습니다.</div>`}
    </div>`;
        document.body.appendChild(overlay);
        const close = () => {
            document.removeEventListener("keydown", onKeyDown);
            overlay.remove();
        };
        const onKeyDown = (event) => {
            if (event.key === "Escape")
                close();
        };
        overlay.querySelector(".hp-trace-close")?.addEventListener("click", close);
        overlay.addEventListener("click", (event) => {
            if (event.target === overlay)
                close();
        });
        document.addEventListener("keydown", onKeyDown);
        return true;
    }
    // ── Custom Confirm Dialog (iframe-safe) ─────────────────────────────────
    function showConfirmDialog(msg) {
        return new Promise((resolve) => {
            const overlay = document.createElement("div");
            overlay.className = "hp-edit-overlay";
            overlay.innerHTML = `
        <div class="hp-edit-box" style="max-width:450px;text-align:center;">
          <p style="font-size:14px;margin:12px 0;color:var(--hp-text);">${msg}</p>
          <div style="display:flex;gap:8px;justify-content:center;margin-top:16px;">
            <button class="hp-btn danger" id="hp-confirm-yes">예</button>
            <button class="hp-btn secondary" id="hp-confirm-no">아니오</button>
          </div>
        </div>
      `;
            document.body.appendChild(overlay);
            let settled = false;
            const finish = (value) => {
                if (settled)
                    return;
                settled = true;
                document.removeEventListener("keydown", onKeyDown);
                overlay.remove();
                resolve(value);
            };
            const onKeyDown = (event) => {
                if (event.key === "Escape")
                    finish(false);
            };
            overlay.querySelector("#hp-confirm-yes")?.addEventListener("click", () => finish(true));
            overlay.querySelector("#hp-confirm-no")?.addEventListener("click", () => finish(false));
            overlay.addEventListener("click", (event) => {
                if (event.target === overlay)
                    finish(false);
            });
            document.addEventListener("keydown", onKeyDown);
        });
    }
    /**
     * Extract HypaV3's first/last wall-clock timestamps from its user-authored
     * "Time and Place" line. The full HypaV3 text is still preserved verbatim in
     * memory.content; this only supplies Hypirk's separate sortable time field.
     */
    function extractHypaV3SummaryTime(text) {
        const line = text
            .split(/\r?\n/)
            .find((part) => /^\s*-?\s*Time and Place\s*:/i.test(part));
        if (!line)
            return nowTimeString();
        const dateTimes = [];
        const pattern = /(\d{4})[.\/-](\d{1,2})[.\/-](\d{1,2})[^\n\d]{0,24}(\d{1,2}):(\d{2})\s*(am|pm)?/gi;
        let match;
        while ((match = pattern.exec(line)) !== null) {
            let hour = Number(match[4]);
            const minute = Number(match[5]);
            const meridiem = (match[6] ?? "").toLowerCase();
            if (meridiem === "pm" && hour < 12)
                hour += 12;
            if (meridiem === "am" && hour === 12)
                hour = 0;
            const pad = (value) => String(value).padStart(2, "0");
            dateTimes.push(`${match[1]}-${pad(Number(match[2]))}-${pad(Number(match[3]))} ${pad(hour)}:${pad(minute)}`);
        }
        if (dateTimes.length >= 2)
            return `${dateTimes[0]} → ${dateTimes[dateTimes.length - 1]}`;
        if (dateTimes.length === 1)
            return dateTimes[0];
        return nowTimeString();
    }
    async function prepareHypaV3Import(rawData, currentMessages) {
        const summariesRaw = Array.isArray(rawData?.summaries) ? rawData.summaries : [];
        const existingTexts = new Set(getNodes().map((memory) => memory.content.trim()).filter(Boolean));
        const currentByChatId = new Map(currentMessages.map((message) => [message.chatId, message]));
        const prepared = [];
        let duplicateCount = 0;
        let invalidCount = 0;
        let totalMatchedMessages = 0;
        let totalUnresolvedMemos = 0;
        let totalNullMemos = 0;
        let importantCount = 0;
        for (const rawSummary of summariesRaw) {
            if (!rawSummary || typeof rawSummary !== "object" || typeof rawSummary.text !== "string") {
                invalidCount += 1;
                continue;
            }
            const text = rawSummary.text.trim();
            if (!text) {
                invalidCount += 1;
                continue;
            }
            if (existingTexts.has(text)) {
                duplicateCount += 1;
                continue;
            }
            // Also deduplicate repeated summary text within the same V3 payload.
            existingTexts.add(text);
            const matchedMessages = [];
            const seenChatIds = new Set();
            let unresolvedMemoCount = 0;
            let nullMemoCount = 0;
            const chatMemos = Array.isArray(rawSummary.chatMemos) ? rawSummary.chatMemos : [];
            for (const memo of chatMemos) {
                if (memo === null || memo === undefined) {
                    nullMemoCount += 1;
                    continue;
                }
                if (typeof memo !== "string" || !memo) {
                    unresolvedMemoCount += 1;
                    continue;
                }
                const message = currentByChatId.get(memo);
                if (!message) {
                    unresolvedMemoCount += 1;
                    continue;
                }
                if (seenChatIds.has(message.chatId))
                    continue;
                seenChatIds.add(message.chatId);
                matchedMessages.push(message);
            }
            const favorite = rawSummary.isImportant === true;
            if (favorite)
                importantCount += 1;
            totalMatchedMessages += matchedMessages.length;
            totalUnresolvedMemos += unresolvedMemoCount;
            totalNullMemos += nullMemoCount;
            prepared.push({
                text,
                time: extractHypaV3SummaryTime(text),
                favorite,
                matchedMessages,
                unresolvedMemoCount,
                nullMemoCount,
            });
        }
        return {
            summaries: prepared,
            duplicateCount,
            invalidCount,
            totalMatchedMessages,
            totalUnresolvedMemos,
            totalNullMemos,
            importantCount,
        };
    }
    async function importCurrentChatHypaV3Data() {
        await ensureChatContext();
        const charIndex = await risuai.getCurrentCharacterIndex();
        const chatIndex = await risuai.getCurrentChatIndex();
        const chat = await risuai.getChatFromIndex(charIndex, chatIndex);
        if (!chat)
            throw new Error("현재 채팅 데이터를 읽지 못했습니다.");
        const rawData = chat.hypaV3Data;
        if (!rawData || !Array.isArray(rawData.summaries)) {
            alert("현재 채팅에서 HypaV3 summaries를 찾지 못했습니다.");
            return;
        }
        const currentMessages = await readChatMessagesRaw();
        const prepared = await prepareHypaV3Import(rawData, currentMessages);
        const totalV3 = rawData.summaries.length;
        if (prepared.summaries.length === 0) {
            alert(`가져올 새 HypaV3 요약이 없습니다.\n\n` +
                `전체 ${totalV3}개 · 이미 존재 ${prepared.duplicateCount}개 · 유효하지 않음 ${prepared.invalidCount}개`);
            return;
        }
        const ok = await showConfirmDialog(`현재 채팅의 HypaV3 요약을 Hypirk에 추가할까요?\n\n` +
            `• HypaV3 전체: ${totalV3}개\n` +
            `• 새로 가져오기: ${prepared.summaries.length}개\n` +
            `• 이미 존재해 건너뜀: ${prepared.duplicateCount}개\n` +
            `• 연결 확인된 원문 UUID: ${prepared.totalMatchedMessages}개\n` +
            `• 현재 채팅에서 못 찾은 UUID: ${prepared.totalUnresolvedMemos}개\n` +
            `• null chatMemo: ${prepared.totalNullMemos}개\n` +
            `• Important → 즐겨찾기: ${prepared.importantCount}개\n\n` +
            `기존 Hypirk 기억은 지우지 않고 뒤에 추가합니다. HypaV3 metrics(마지막 Recent/Similar/Random 기록)는 가져오지 않습니다.`);
        if (!ok)
            return;
        let imported = 0;
        let linkedGroups = 0;
        const importedAt = Date.now();
        for (const item of prepared.summaries) {
            const linkedMessages = await registerMessages(item.matchedMessages);
            if (linkedMessages.length)
                linkedGroups += 1;
            const memory = {
                id: nextNodeId(),
                time: item.time,
                content: item.text,
                createdAt: importedAt + imported,
            };
            if (item.favorite)
                memory.favorite = true;
            appendMemoryEntry(memory, linkedMessages);
            imported += 1;
        }
        // All retained source refs were matched against the current raw chat before
        // insertion, so normal Hypirk link-health bookkeeping can safely take over.
        await saveState();
        await reconcileMessageLinks(currentMessages);
        clearTokenCache();
        alert(`HypaV3 가져오기 완료!\n\n` +
            `• 기억 ${imported}개 추가\n` +
            `• 엔트리 ${imported}개 추가\n` +
            `• 원문이 1개 이상 연결된 그룹 ${linkedGroups}개\n` +
            `• 원문 연결 없이 요약만 가져온 그룹 ${imported - linkedGroups}개\n\n` +
            `원문 UUID가 현재 채팅에서 확인된 경우에만 연결했습니다.`);
    }
    function jsonByteSize(value) {
        try {
            return new TextEncoder().encode(JSON.stringify(value)).length;
        }
        catch (_) {
            return 0;
        }
    }
    function formatStorageBytes(bytes) {
        if (bytes < 1024)
            return `${bytes} B`;
        if (bytes < 1024 * 1024)
            return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    }
    function parseLocalEmbeddingCacheKey(key) {
        if (!key.startsWith(LOCAL_EMBEDDING_CACHE_PREFIX))
            return null;
        const encoded = key.slice(LOCAL_EMBEDDING_CACHE_PREFIX.length);
        const separator = encoded.indexOf("::");
        if (separator < 0)
            return null;
        try {
            return {
                charId: decodeURIComponent(encoded.slice(0, separator)),
                chatId: decodeURIComponent(encoded.slice(separator + 2)),
            };
        }
        catch (_) {
            return null;
        }
    }
    function embeddingCacheUsage(entries) {
        let contentBytes = 0;
        let dialogueBytes = 0;
        let contentCount = 0;
        let dialogueCount = 0;
        for (const value of Object.values(entries)) {
            if (!value || typeof value !== "object")
                continue;
            if (value.embedding !== undefined) {
                contentCount += 1;
                contentBytes += jsonByteSize({
                    embedding: value.embedding,
                    embeddingSourceHash: value.embeddingSourceHash,
                    embeddingConfigHash: value.embeddingConfigHash,
                });
            }
            if (value.dialogueEmbeddingChildren !== undefined) {
                dialogueCount += 1;
                dialogueBytes += jsonByteSize({
                    dialogueEmbeddingChildren: value.dialogueEmbeddingChildren,
                    dialogueEmbeddingSourceHash: value.dialogueEmbeddingSourceHash,
                    dialogueEmbeddingConfigHash: value.dialogueEmbeddingConfigHash,
                });
            }
        }
        return { contentBytes, dialogueBytes, contentCount, dialogueCount };
    }
    function buildStoredDataBreakdown(saved, localRecord) {
        const entries = Array.isArray(saved?.entries) ? saved.entries : [];
        const memories = entries.flatMap(entry => entry.memory ? [entry.memory] : []);
        const memoryCore = memories.map((memory) => ({
            id: memory?.id,
            time: memory?.time,
            category: memory?.category,
            tags: memory?.tags,
            content: memory?.content,
            activationCues: memory?.activationCues,
            createdAt: memory?.createdAt,
            favorite: memory?.favorite,
            likedAt: memory?.likedAt,
        }));
        const nodeTranslations = memories
            .filter((memory) => memory?.translation)
            .map((memory) => ({ id: memory.id, translation: memory.translation }));
        const sourceLinks = entries.map(entry => entry.linkedMessages);
        const messageRecords = saved?.messages ?? {};
        const stateEntries = Object.fromEntries(memories.map((memory, index) => [String(memory?.id ?? index), memory]));
        const localEntries = localRecord?.memories && typeof localRecord.memories === "object"
            ? localRecord.memories
            : {};
        const stateEmbedding = embeddingCacheUsage(stateEntries);
        const localEmbedding = embeddingCacheUsage(localEntries);
        const cacheStorage = (stateBytes, localBytes) => stateBytes > 0 && localBytes > 0 ? "State + Local" : localBytes > 0 ? "Local" : "State";
        const stateTranslationViewCache = saved?.translationViewCache ?? {};
        const localTranslationViewCache = localRecord?.translationViewCache ?? {};
        const stateTranslationBytes = Object.keys(stateTranslationViewCache).length > 0
            ? jsonByteSize(stateTranslationViewCache)
            : 0;
        const localTranslationBytes = Object.keys(localTranslationViewCache).length > 0
            ? jsonByteSize(localTranslationViewCache)
            : 0;
        const stateLastRetrieval = {
            lastNodeScores: saved?.lastNodeScores,
            lastChosenNodeIds: saved?.lastChosenNodeIds,
            lastRecentNodeIds: saved?.lastRecentNodeIds,
        };
        const localLastRetrieval = {
            lastNodeScores: localRecord?.lastNodeScores,
            lastChosenNodeIds: localRecord?.lastChosenNodeIds,
            lastRecentNodeIds: localRecord?.lastRecentNodeIds,
        };
        const stateLastRetrievalBytes = Object.keys(saved?.lastNodeScores ?? {}).length > 0 || (saved?.lastChosenNodeIds?.length ?? 0) > 0 || (saved?.lastRecentNodeIds?.length ?? 0) > 0
            ? jsonByteSize(stateLastRetrieval)
            : 0;
        const localLastRetrievalBytes = Object.keys(localRecord?.lastNodeScores ?? {}).length > 0 || (localRecord?.lastChosenNodeIds?.length ?? 0) > 0 || (localRecord?.lastRecentNodeIds?.length ?? 0) > 0
            ? jsonByteSize(localLastRetrieval)
            : 0;
        return [
            { label: "노드 원본", fields: "entries[].memory: content, time, category, tags, activationCues, favorite, likedAt", purpose: "사용자가 관리하고 모델에 주입하는 핵심 기억", storage: "State", bytes: jsonByteSize(memoryCore) },
            { label: "노드 번역문", fields: "entries[].memory.translation", purpose: "검수·편집 가능한 노드 병렬 번역문", storage: "State", bytes: jsonByteSize(nodeTranslations) },
            { label: "원문 연결", fields: "entries[].linkedMessages", purpose: "각 엔트리가 참조하는 메시지 번호", storage: "State", bytes: jsonByteSize(sourceLinks) },
            { label: "공용 메시지 검증", fields: "messages: chatId, index, anchor", purpose: "평상시 chatId+index 연결; setFullChat형 ID rewrite 확인 뒤에만 anchor/hash 보호 활성화", storage: "State", bytes: jsonByteSize(messageRecords) },
            { label: "마지막 검색 UI", fields: "lastNodeScores, lastChosenNodeIds, lastRecentNodeIds", purpose: "현재 채팅 카드의 마지막 점수·Recent/Chosen 배지", storage: cacheStorage(stateLastRetrievalBytes, localLastRetrievalBytes), bytes: stateLastRetrievalBytes + localLastRetrievalBytes },
            { label: "채팅별 설정", fields: "regexRuleIds, summarizerNote", purpose: "현재 채팅의 정규식 선택과 요약 참고 메모", storage: "State", bytes: jsonByteSize({ regexRuleIds: saved?.regexRuleIds, summarizerNote: saved?.summarizerNote }) },
            { label: "소유·복구 경계", fields: "ownerCharId, ownerChatId, ownerCharName, ownerChatName, lastVerifiedSummarizedIndex, hashRecoveryEnabled, hashRecoveryActivatedAt", purpose: "사람이 읽는 캐릭터·채팅 이름, 다른 채팅 오인 연결 방지, 마지막 안전 경계, 채팅별 hash 보호 승격 상태", storage: "State", bytes: jsonByteSize({ ownerCharId: saved?.ownerCharId, ownerChatId: saved?.ownerChatId, ownerCharName: saved?.ownerCharName, ownerChatName: saved?.ownerChatName, lastVerifiedSummarizedIndex: saved?.lastVerifiedSummarizedIndex, hashRecoveryEnabled: saved?.hashRecoveryEnabled, hashRecoveryActivatedAt: saved?.hashRecoveryActivatedAt }) },
            { label: "UI 표시 상태", fields: "translationVisibleNodeIds", purpose: "번역문이 펼쳐진 노드 기억", storage: "State", bytes: jsonByteSize(saved?.translationVisibleNodeIds ?? []) },
            { label: "연결 메시지 번역 캐시", fields: "translationViewCache", purpose: "Risu 번역 캐시 조회 결과; Thoughts·HTML 태그 제거 후 보관", storage: cacheStorage(stateTranslationBytes, localTranslationBytes), bytes: stateTranslationBytes + localTranslationBytes },
            { label: "Content 임베딩", fields: "embedding, embeddingSourceHash, embeddingConfigHash", purpose: "기억 내용 유사도 계산용 재생성 가능 벡터", storage: cacheStorage(stateEmbedding.contentBytes, localEmbedding.contentBytes), bytes: stateEmbedding.contentBytes + localEmbedding.contentBytes },
            { label: "Dialogue 임베딩", fields: "dialogueEmbeddingChildren, dialogueEmbeddingSourceHash, dialogueEmbeddingConfigHash", purpose: "Content의 인용 대사에서 파생한 의미 유사도용 재생성 가능 벡터", storage: cacheStorage(stateEmbedding.dialogueBytes, localEmbedding.dialogueBytes), bytes: stateEmbedding.dialogueBytes + localEmbedding.dialogueBytes },
            { label: "스키마 표식", fields: "format, schemaVersion", purpose: "저장 형식 판별과 마이그레이션", storage: "State", bytes: jsonByteSize({ format: saved?.format, schemaVersion: saved?.schemaVersion }) },
        ];
    }
    async function collectStoredChatDataSummaries() {
        let characters = [];
        try {
            let granted = true;
            if (typeof risuai.requestPluginPermission === "function") {
                granted = await risuai.requestPluginPermission("db");
            }
            const db = granted && typeof risuai.getDatabase === "function"
                ? await risuai.getDatabase(["characters"])
                : null;
            characters = Array.isArray(db?.characters) ? db.characters : [];
        }
        catch (_) {
            characters = [];
        }
        const namesByPair = new Map();
        const pairByStateKey = new Map();
        characters.forEach((character, charIndex) => {
            const charId = String(character?.chaId ?? "");
            const charName = String(character?.name ?? `캐릭터 ${charIndex + 1}`);
            const chats = Array.isArray(character?.chats) ? character.chats : [];
            chats.forEach((chat, chatIndex) => {
                const chatId = String(chat?.id ?? "");
                if (!charId || !chatId)
                    return;
                const pair = `${charId}\u0000${chatId}`;
                namesByPair.set(pair, {
                    charName,
                    chatName: String(chat?.name ?? chat?.title ?? `채팅 ${chatIndex + 1}`),
                });
                pairByStateKey.set(getStorageKey(charId, chatId), { charId, chatId });
            });
        });
        const localStorage = await getDeviceLocalEmbeddingStorage();
        const localRecords = new Map();
        if (localStorage) {
            try {
                const keys = await localStorage.keys();
                for (const key of keys.filter(item => item.startsWith(LOCAL_EMBEDDING_CACHE_PREFIX) || item.startsWith(LOCAL_DERIVED_CACHE_PREFIX))) {
                    const parsed = parseLocalEmbeddingCacheKey(key.replace(LOCAL_DERIVED_CACHE_PREFIX, LOCAL_EMBEDDING_CACHE_PREFIX));
                    if (!parsed)
                        continue;
                    const record = await localStorage.getItem(getLocalEmbeddingCacheKey(parsed.charId, parsed.chatId)) ?? {};
                    if (record && typeof record === "object") {
                        const derived = await localStorage.getItem(getLocalDerivedCacheKey(parsed.charId, parsed.chatId));
                        localRecords.set(`${parsed.charId}\u0000${parsed.chatId}`, { ...record, ...(derived ?? {}) });
                    }
                }
            }
            catch (_) {
                // The synced state list can still be displayed without local-cache details.
            }
        }
        const rowsByPair = new Map();
        const pluginKeys = await risuai.pluginStorage.keys();
        const stateKeys = pluginKeys.filter((key) => key.startsWith("hypirkproto_entries_v2_"));
        for (const key of stateKeys) {
            const saved = await risuai.pluginStorage.getItem(key);
            if (!saved || typeof saved !== "object")
                continue;
            const knownPair = pairByStateKey.get(key);
            const charId = String(saved.ownerCharId ?? knownPair?.charId ?? "");
            const chatId = String(saved.ownerChatId ?? knownPair?.chatId ?? "");
            if (!charId || !chatId)
                continue;
            const pair = `${charId}\u0000${chatId}`;
            const names = namesByPair.get(pair);
            const stateMemories = Array.isArray(saved.entries) ? saved.entries.flatMap((entry) => entry.memory ? [entry.memory] : []) : [];
            const stateEntries = Object.fromEntries(stateMemories.map((memory, index) => [String(memory?.id ?? index), memory]));
            const stateUsage = embeddingCacheUsage(stateEntries);
            const localRecord = localRecords.get(pair);
            const localEntries = localRecord?.memories && typeof localRecord.memories === "object"
                ? localRecord.memories
                : {};
            const localUsage = embeddingCacheUsage(localEntries);
            const hasStateCache = stateUsage.contentCount + stateUsage.dialogueCount > 0 ||
                Object.keys(saved.translationViewCache ?? {}).length > 0 ||
                Object.keys(saved.lastNodeScores ?? {}).length > 0 ||
                (saved.lastChosenNodeIds?.length ?? 0) > 0 ||
                (saved.lastRecentNodeIds?.length ?? 0) > 0;
            const hasLocalCache = localUsage.contentCount + localUsage.dialogueCount > 0 ||
                Object.keys(localRecord?.translationViewCache ?? {}).length > 0 ||
                Object.keys(localRecord?.lastNodeScores ?? {}).length > 0 ||
                (localRecord?.lastChosenNodeIds?.length ?? 0) > 0 ||
                (localRecord?.lastRecentNodeIds?.length ?? 0) > 0;
            rowsByPair.set(pair, {
                charId,
                chatId,
                charName: names?.charName ?? (typeof saved.ownerCharName === "string" ? saved.ownerCharName : null) ?? (charId === currentCharId ? getDetectedChatUiMetadataForCurrentContext()?.charName ?? charId : charId),
                chatName: names?.chatName ?? (typeof saved.ownerChatName === "string" ? saved.ownerChatName : null) ?? (chatId === currentChatId ? getDetectedChatUiMetadataForCurrentContext()?.chatName ?? chatId : chatId),
                memoryCount: stateMemories.length,
                stateBytes: jsonByteSize(saved),
                localBytes: jsonByteSize(localRecord ?? {}),
                contentCacheBytes: localUsage.contentBytes + stateUsage.contentBytes,
                dialogueCacheBytes: localUsage.dialogueBytes + stateUsage.dialogueBytes,
                contentCacheCount: Math.max(localUsage.contentCount, stateUsage.contentCount),
                dialogueCacheCount: Math.max(localUsage.dialogueCount, stateUsage.dialogueCount),
                cacheLocation: hasLocalCache && hasStateCache ? "local + state" : hasLocalCache ? "local" : hasStateCache ? "state" : "none",
                breakdown: buildStoredDataBreakdown(saved, localRecord),
                isCurrent: charId === currentCharId && chatId === currentChatId,
            });
        }
        // Keep an orphaned local sidecar visible even if its syncable state was removed.
        for (const [pair, record] of localRecords) {
            if (rowsByPair.has(pair))
                continue;
            const separator = pair.indexOf("\u0000");
            const charId = pair.slice(0, separator);
            const chatId = pair.slice(separator + 1);
            const names = namesByPair.get(pair);
            const usage = embeddingCacheUsage(record?.memories ?? {});
            rowsByPair.set(pair, {
                charId,
                chatId,
                charName: names?.charName ?? charId,
                chatName: names?.chatName ?? chatId,
                memoryCount: 0,
                stateBytes: 0,
                localBytes: jsonByteSize(record),
                contentCacheBytes: usage.contentBytes,
                dialogueCacheBytes: usage.dialogueBytes,
                contentCacheCount: usage.contentCount,
                dialogueCacheCount: usage.dialogueCount,
                cacheLocation: "local",
                breakdown: buildStoredDataBreakdown({}, record),
                isCurrent: charId === currentCharId && chatId === currentChatId,
            });
        }
        return [...rowsByPair.values()].sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) ||
            a.charName.localeCompare(b.charName) ||
            a.chatName.localeCompare(b.chatName));
    }
    async function showStorageDataManagerDialog() {
        const rows = await collectStoredChatDataSummaries();
        const totalStateBytes = rows.reduce((sum, row) => sum + row.stateBytes, 0);
        const totalLocalBytes = rows.reduce((sum, row) => sum + row.localBytes, 0);
        const totalContentBytes = rows.reduce((sum, row) => sum + row.contentCacheBytes, 0);
        const totalDialogueBytes = rows.reduce((sum, row) => sum + row.dialogueCacheBytes, 0);
        const totalTranslationViewBytes = rows.reduce((sum, row) => sum + (row.breakdown.find((item) => item.label === "연결 메시지 번역 캐시")?.bytes ?? 0), 0);
        const locationLabel = {
            local: "Local",
            state: "기존 State",
            "local + state": "이전 중",
            none: "없음",
        };
        const body = rows.length > 0
            ? rows.map((row) => {
                const detailRows = row.breakdown.map((item) => `
            <tr style="border-top:var(--hp-border-width) solid var(--hp-border);">
              <td style="padding:7px 8px;"><strong>${escapeHtml(item.label)}</strong></td>
              <td style="padding:7px 8px;"><code style="font-size:10px;white-space:normal;overflow-wrap:anywhere;">${escapeHtml(item.fields)}</code></td>
              <td style="padding:7px 8px;color:var(--hp-text-muted);">${escapeHtml(item.purpose)}</td>
              <td style="padding:7px 8px;white-space:nowrap;">${escapeHtml(item.storage)}</td>
              <td style="padding:7px 8px;text-align:right;white-space:nowrap;">${formatStorageBytes(item.bytes)}</td>
            </tr>`).join("");
                return `
          <tr style="border-top:var(--hp-border-width) solid var(--hp-border);">
            <td style="padding:9px 8px;min-width:150px;"><strong>${escapeHtml(row.charName)}</strong><br><span style="color:var(--hp-text-muted);">${escapeHtml(row.chatName)}</span>${row.isCurrent ? `<br><span style="font-size:10px;color:var(--hp-primary);">현재 채팅</span>` : ""}</td>
            <td style="padding:9px 8px;text-align:right;">${row.memoryCount}</td>
            <td style="padding:9px 8px;text-align:right;">${formatStorageBytes(row.stateBytes)}</td>
            <td style="padding:9px 8px;text-align:right;">${row.contentCacheCount}개<br><span style="color:var(--hp-text-muted);">${formatStorageBytes(row.contentCacheBytes)}</span></td>
            <td style="padding:9px 8px;text-align:right;">${row.dialogueCacheCount}개<br><span style="color:var(--hp-text-muted);">${formatStorageBytes(row.dialogueCacheBytes)}</span></td>
            <td style="padding:9px 8px;white-space:nowrap;">${locationLabel[row.cacheLocation]}</td>
          </tr>
          <tr><td colspan="6" style="padding:0 8px 10px;">
            <details>
              <summary style="cursor:pointer;color:var(--hp-text-muted);font-size:10px;">용도·필드별 상세 보기 · Local ${formatStorageBytes(row.localBytes)}</summary>
              <div style="overflow:auto;margin-top:6px;border:var(--hp-border-width) solid var(--hp-border);border-radius:var(--hp-radius-sm);">
                <table style="width:100%;border-collapse:collapse;font-size:10px;min-width:720px;">
                  <thead style="background:var(--hp-inset);"><tr><th style="padding:7px 8px;text-align:left;">용도</th><th style="padding:7px 8px;text-align:left;">필드</th><th style="padding:7px 8px;text-align:left;">무엇을 저장하나</th><th style="padding:7px 8px;text-align:left;">위치</th><th style="padding:7px 8px;text-align:right;">추정 용량</th></tr></thead>
                  <tbody>${detailRows}</tbody>
                </table>
              </div>
            </details>
          </td></tr>`;
            }).join("")
            : `<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--hp-text-muted);">저장된 Hypirk 채팅 데이터를 찾지 못했습니다.</td></tr>`;
        const overlay = document.createElement("div");
        overlay.className = "hp-edit-overlay hp-storage-data-overlay";
        overlay.innerHTML = `
      <div class="hp-edit-box" role="dialog" aria-modal="true" aria-label="Hypirk 저장 데이터" style="width:min(96vw,980px);max-width:980px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px;">
          <h3 style="margin:0;">Hypirk 저장 데이터</h3>
          <button class="hp-btn secondary small" id="hp-storage-data-close" type="button">닫기</button>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px;font-size:11px;color:var(--hp-text-muted);">
          <span>채팅 ${rows.length}개</span><span>·</span>
          <span>State ${formatStorageBytes(totalStateBytes)}</span><span>·</span>
          <span>Local ${formatStorageBytes(totalLocalBytes)}</span><span>·</span>
          <span>Content 캐시 ${formatStorageBytes(totalContentBytes)}</span><span>·</span>
          <span>Dialogue 캐시 ${formatStorageBytes(totalDialogueBytes)}</span><span>·</span>
          <span>연결 메시지 번역 캐시 ${formatStorageBytes(totalTranslationViewBytes)}</span>
        </div>

        <div style="overflow:auto;max-height:68vh;border:var(--hp-border-width) solid var(--hp-border);border-radius:8px;">
          <table style="width:100%;border-collapse:collapse;font-size:11px;">
            <thead style="position:sticky;top:0;background:var(--hp-surface);z-index:1;">
              <tr><th style="padding:8px;text-align:left;">캐릭터 / 채팅</th><th style="padding:8px;text-align:right;">노드</th><th style="padding:8px;text-align:right;">State</th><th style="padding:8px;text-align:right;">Content 캐시</th><th style="padding:8px;text-align:right;">Dialogue 캐시</th><th style="padding:8px;text-align:left;">위치</th></tr>
            </thead>
            <tbody>${body}</tbody>
          </table>
        </div>
        <div style="margin-top:8px;color:var(--hp-text-muted);font-size:10px;line-height:1.5;">읽기 전용 현황입니다. ‘기존 State’는 아직 해당 채팅을 열지 않아 로컬 이전 전인 캐시를 뜻합니다. 상세 용량은 각 용도에 포함된 JSON을 따로 직렬화한 추정치라 State·Local 전체 크기와 정확히 합산되지는 않습니다.</div>
      </div>`;
        document.body.appendChild(overlay);
        const closeButton = overlay.querySelector("#hp-storage-data-close");
        let closed = false;
        const close = () => {
            if (closed)
                return;
            closed = true;
            document.removeEventListener("keydown", onKeyDown);
            overlay.remove();
        };
        const onKeyDown = (event) => {
            if (event.key === "Escape")
                close();
        };
        closeButton?.addEventListener("click", close);
        overlay.addEventListener("click", (event) => {
            if (event.target === overlay)
                close();
        });
        document.addEventListener("keydown", onKeyDown);
    }
    // ── Event Binding ────────────────────────────────────────────────────────
    // Body survives renderUI's innerHTML replacement. Abort old global listeners
    // before binding the next toolbar; stale wrappers must never close new panels.
    let toolbarMenuEvents = null;
    function bindToolbarMenus() {
        toolbarMenuEvents?.abort();
        toolbarMenuEvents = new AbortController();
        const { signal } = toolbarMenuEvents;
        const menus = Array.from(document.querySelectorAll(".hp-ui-menu"));
        const panels = Array.from(document.querySelectorAll(".hp-ui-menu-root, .hp-ui-submenu-panel"));
        const panelFor = (trigger) => document.getElementById(trigger.getAttribute("aria-controls") ?? "");
        const triggerFor = (panel) => menus.flatMap(menu => Array.from(menu.querySelectorAll("[aria-controls]")))
            .find(trigger => trigger.getAttribute("aria-controls") === panel.id);
        const items = (panel) => Array.from(panel.querySelectorAll("button:not(:disabled), input:not(:disabled)"))
            .filter(item => item.closest('[role="menu"]') === panel && !item.hidden);
        const closePanel = (panel) => {
            panel.querySelectorAll(".hp-ui-submenu-panel").forEach(closePanel);
            panel.hidden = true;
            triggerFor(panel)?.setAttribute("aria-expanded", "false");
        };
        const closeAll = () => panels.filter(panel => panel.classList.contains("hp-ui-menu-root")).forEach(closePanel);
        const bounds = () => {
            const viewport = window.visualViewport;
            const left = (viewport?.offsetLeft ?? 0) + 8;
            const top = (viewport?.offsetTop ?? 0) + 8;
            return { left, top, right: left + (viewport?.width ?? window.innerWidth) - 16,
                bottom: top + (viewport?.height ?? window.innerHeight) - 16 };
        };
        const positionPanel = (panel) => {
            const trigger = triggerFor(panel);
            if (!trigger || panel.hidden)
                return;
            const b = bounds();
            const isSub = panel.classList.contains("hp-ui-submenu-panel");
            const preferredWidth = panel.classList.contains("hp-tools-submenu-panel") ? 236
                : panel.classList.contains("hp-ui-menu-root") && !panel.classList.contains("hp-tools-menu-root") && !panel.classList.contains("hp-data-menu-root") ? 238 : 196;
            // Keep a strip of the parent visible on phones so its trigger remains tappable.
            panel.style.width = `${Math.min(preferredWidth, Math.max(1, b.right - b.left - (isSub ? 40 : 0)))}px`;
            panel.style.maxHeight = `${Math.max(1, b.bottom - b.top)}px`;
            const rect = trigger.getBoundingClientRect();
            const width = panel.getBoundingClientRect().width;
            let x = rect.left;
            let y = rect.bottom + 5;
            if (isSub) {
                const parent = trigger.closest('[role="menu"]').getBoundingClientRect();
                const rightRoom = b.right - parent.right - 5;
                const leftRoom = parent.left - b.left - 5;
                const toRight = rightRoom >= width || (leftRoom < width && rightRoom >= leftRoom);
                x = toRight ? parent.right + 5 : parent.left - width - 5;
                y = rect.top - 5;
                panel.dataset.side = toRight ? "right" : "left";
                trigger.dataset.side = panel.dataset.side;
            }
            x = Math.max(b.left, Math.min(x, b.right - width));
            const height = panel.getBoundingClientRect().height;
            if (!isSub && y + height > b.bottom && rect.top - height - 5 >= b.top)
                y = rect.top - height - 5;
            y = Math.max(b.top, Math.min(y, b.bottom - height));
            panel.style.left = `${x}px`;
            panel.style.top = `${y}px`;
        };
        const openPanel = (trigger, focusFirst = false) => {
            const panel = panelFor(trigger);
            if (!panel)
                return;
            if (panel.classList.contains("hp-ui-menu-root"))
                closeAll();
            else
                trigger.closest('[role="menu"]')?.querySelectorAll(".hp-ui-submenu-panel").forEach(other => {
                    if (other !== panel)
                        closePanel(other);
                });
            panel.hidden = false;
            trigger.setAttribute("aria-expanded", "true");
            positionPanel(panel);
            if (focusFirst)
                items(panel)[0]?.focus();
        };
        for (const menu of menus) {
            menu.querySelectorAll(".hp-ui-menu-button, .hp-ui-submenu-trigger").forEach(trigger => {
                trigger.addEventListener("click", () => {
                    const panel = panelFor(trigger);
                    if (!panel)
                        return;
                    if (panel.hidden)
                        openPanel(trigger);
                    else
                        closePanel(panel);
                }, { signal });
                trigger.addEventListener("keydown", event => {
                    if (trigger.classList.contains("hp-ui-menu-button") && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                        event.preventDefault();
                        openPanel(trigger, true);
                        if (event.key === "ArrowUp")
                            items(panelFor(trigger)).at(-1)?.focus();
                    }
                }, { signal });
            });
            menu.addEventListener("click", event => {
                const target = event.target;
                // Let the existing action handler run once. Labels/checkboxes stay open
                // through their native change event; never synthesize another click.
                const action = target.closest("button");
                if (action && !action.disabled && !action.matches(".hp-ui-menu-button, .hp-ui-submenu-trigger"))
                    closeAll();
            }, { signal });
            menu.addEventListener("keydown", event => {
                const active = document.activeElement;
                const panel = active?.closest('[role="menu"]');
                if (!active || !panel)
                    return;
                if (event.key === "ArrowRight" && active.matches(".hp-ui-submenu-trigger")) {
                    event.preventDefault();
                    openPanel(active, true);
                    return;
                }
                if (event.key === "Escape" || (event.key === "ArrowLeft" && panel.classList.contains("hp-ui-submenu-panel"))) {
                    event.preventDefault();
                    closePanel(panel);
                    triggerFor(panel)?.focus();
                    return;
                }
                const choices = items(panel);
                if (!choices.length)
                    return;
                let index = choices.indexOf(active);
                if (event.key === "ArrowDown")
                    index = (index + 1) % choices.length;
                else if (event.key === "ArrowUp")
                    index = (index - 1 + choices.length) % choices.length;
                else if (event.key === "Home")
                    index = 0;
                else if (event.key === "End")
                    index = choices.length - 1;
                else
                    return;
                event.preventDefault();
                choices[index]?.focus();
            }, { signal });
        }
        document.addEventListener("pointerdown", event => {
            if (!menus.some(menu => menu.contains(event.target)))
                closeAll();
        }, { signal });
        document.addEventListener("focusin", event => {
            if (!menus.some(menu => menu.contains(event.target)))
                closeAll();
        }, { signal });
        document.addEventListener("keydown", event => {
            if (event.key !== "Escape")
                return;
            const root = panels.find(panel => panel.classList.contains("hp-ui-menu-root") && !panel.hidden);
            if (root && !menus.some(menu => menu.contains(event.target))) {
                closeAll();
                triggerFor(root)?.focus();
            }
        }, { signal });
        const reposition = () => panels.filter(panel => !panel.hidden).forEach(positionPanel);
        window.addEventListener("resize", reposition, { signal });
        window.visualViewport?.addEventListener("resize", reposition, { signal });
        window.visualViewport?.addEventListener("scroll", reposition, { signal });
        document.addEventListener("scroll", event => {
            // Scrolling a parent menu moves its row anchors; keep the flyout attached.
            if (event.target instanceof HTMLElement && event.target.matches('[role="menu"]'))
                reposition();
            else
                closeAll();
        }, { capture: true, signal });
    }
    function attachUIEvents(pendingMessages) {
        restoreSettingsEdits();
        // Helper: wrap async handlers with error boundary
        function safeAsync(fn, context, { settingsAction = false } = {}) {
            return async (...args) => {
                if (settingsActionBusy)
                    return;
                const workspace = document.querySelector(".hp-settings-workspace");
                if (settingsAction) {
                    settingsActionBusy = true;
                    if (workspace)
                        workspace.inert = true;
                }
                try {
                    await fn(...args);
                }
                catch (e) {
                    console.error(`[Hypirk] UI error (${context}):`, e);
                    alert(`Error: ${e instanceof Error ? e.message : String(e)}`);
                }
                finally {
                    if (settingsAction) {
                        settingsActionBusy = false;
                        if (workspace)
                            workspace.inert = false;
                        const currentWorkspace = document.querySelector(".hp-settings-workspace");
                        if (currentWorkspace)
                            currentWorkspace.inert = false;
                    }
                }
            };
        }
        document.querySelectorAll("[data-copy-text]").forEach((element) => {
            element.addEventListener("click", async () => {
                const value = element.dataset.copyText ?? "";
                await copyTextToClipboard(value);
            });
        });
        // Score details must be explicitly toggleable on touch devices where hover is absent.
        const scoreTooltips = Array.from(document.querySelectorAll(".hp-score-tooltip[data-tooltip]"));
        const closeScoreTooltips = (except) => {
            for (const tooltip of scoreTooltips) {
                if (tooltip === except)
                    continue;
                tooltip.classList.remove("hp-score-tooltip-open");
                tooltip.setAttribute("aria-expanded", "false");
            }
        };
        for (const tooltip of scoreTooltips) {
            tooltip.setAttribute("role", "button");
            tooltip.setAttribute("aria-expanded", "false");
            const toggle = (event) => {
                event.preventDefault();
                event.stopPropagation();
                const scoreNodeId = tooltip.dataset.scoreNodeId;
                if (scoreNodeId && showEmbeddingTraceDialog(scoreNodeId)) {
                    closeScoreTooltips();
                    return;
                }
                const willOpen = !tooltip.classList.contains("hp-score-tooltip-open");
                closeScoreTooltips(tooltip);
                tooltip.classList.toggle("hp-score-tooltip-open", willOpen);
                tooltip.setAttribute("aria-expanded", String(willOpen));
            };
            tooltip.addEventListener("click", toggle);
            tooltip.addEventListener("keydown", (event) => {
                if (event.key === "Enter" || event.key === " ") {
                    toggle(event);
                }
                else if (event.key === "Escape") {
                    tooltip.classList.remove("hp-score-tooltip-open");
                    tooltip.setAttribute("aria-expanded", "false");
                }
            });
        }
        document.getElementById("hp-body")?.addEventListener("click", (event) => {
            if (!event.target?.closest?.(".hp-score-tooltip")) {
                closeScoreTooltips();
            }
        });
        // Close button
        const closeBtn = document.getElementById("hp-close");
        if (closeBtn) {
            closeBtn.addEventListener("click", safeAsync(async () => {
                await flushInlineCardChanges();
                if (!(await commitSettingsBoundary()))
                    return;
                await risuai.hideContainer();
                settingsEdits.clear();
                regexSettingsDraft = null;
            }, "close-after-inline-save", { settingsAction: true }));
        }
        // Full-message viewing is available only inside the manual-summary dialog.
        document.querySelectorAll(".hp-summarize-pending-message").forEach((row) => {
            const openPendingMessage = () => {
                const pendingIndex = Number(row.dataset.pendingIndex);
                const messageIndex = Number(row.dataset.messageIndex);
                if (!Number.isInteger(pendingIndex) || pendingIndex < 0)
                    return;
                const message = pendingMessages[pendingIndex];
                if (!message)
                    return;
                const msgText = `[${messageIndex}]\n${message.content}`;
                showMessageViewer(`미요약 메시지 ${messageIndex}`, msgText);
            };
            row.addEventListener("click", openPendingMessage);
            row.addEventListener("keydown", (e) => {
                const key = e.key;
                if (key === "Enter" || key === " ") {
                    e.preventDefault();
                    openPendingMessage();
                }
            });
        });
        const bindMainNavToggle = (buttonId, targetTab) => {
            const button = document.getElementById(buttonId);
            button?.addEventListener("click", safeAsync(async () => {
                const nextTab = activeTab === targetTab ? "nodes" : targetTab;
                if (!(await commitSettingsBoundary()))
                    return;
                selectMainTabWithoutRender(nextTab);
                if (nextTab !== "lorebook") {
                    await renderUI(false);
                    return;
                }
                const hasCachedLorebook = lorebookPageContext?.contextKey === getUiContextKey();
                if (hasCachedLorebook) {
                    await renderUI(false);
                    return;
                }
                lorebookPageLoading = true;
                lorebookPageError = "";
                await renderUI(false);
                await loadLorebookPageContext();
                if (activeTab === "lorebook")
                    await renderUI(false);
            }, `main-nav-${targetTab}`, { settingsAction: true }));
        };
        bindMainNavToggle("hp-nav-settings", "settings");
        bindMainNavToggle("hp-nav-lorebook", "lorebook");
        document.getElementById("hp-refresh-lorebook")?.addEventListener("click", safeAsync(async () => {
            lorebookPageLoading = true;
            lorebookPageError = "";
            await renderUI(true);
            await loadLorebookPageContext();
            if (activeTab === "lorebook")
                await renderUI(true);
        }, "refresh-lorebook-page"));
        document.getElementById("hp-save-lorebook-retrieval")?.addEventListener("click", safeAsync(async () => {
            const tokenInput = document.getElementById("hp-lorebook-max-tokens");
            const separatorInput = document.getElementById("hp-lorebook-separator");
            const value = Number(tokenInput?.value ?? "");
            if (!Number.isInteger(value) || value < 0) {
                tokenInput?.focus();
                alert("로어북 토큰에는 0 이상의 정수를 입력해주세요.");
                return;
            }
            maxLorebookTokens = value;
            lorebookSeparator = separatorInput?.value ?? lorebookSeparator;
            await saveSettings();
            const status = document.getElementById("hp-lorebook-save-status");
            if (status)
                status.textContent = "저장되었습니다.";
        }, "save-lorebook-retrieval"));
        document.getElementById("hp-clear-lorebook-embedding-cache")?.addEventListener("click", safeAsync(async () => {
            const ok = await showConfirmDialog("현재 채팅의 로어북 임베딩 캐시를 초기화할까요?<br>다음 검색 때 필요한 벡터를 다시 생성합니다.");
            if (!ok)
                return;
            const storage = await getDeviceLocalEmbeddingStorage();
            if (storage && currentCharId && currentChatId) {
                await storage.removeItem(getLocalLorebookEmbeddingCacheKey(currentCharId, currentChatId));
            }
            const status = document.getElementById("hp-lorebook-save-status");
            if (status)
                status.textContent = "임베딩 캐시를 초기화했습니다.";
        }, "clear-lorebook-embedding-cache"));
        document.querySelectorAll(".hp-settings-collapse-toggle").forEach((toggle) => {
            toggle.addEventListener("click", () => {
                const contentId = toggle.getAttribute("aria-controls");
                const content = contentId ? document.getElementById(contentId) : null;
                if (!content)
                    return;
                const expanded = toggle.getAttribute("aria-expanded") === "true";
                toggle.setAttribute("aria-expanded", String(!expanded));
                content.hidden = expanded;
            });
        });
        document.getElementById("hp-search-toggle")?.addEventListener("click", () => {
            nodeSearchOpen = !nodeSearchOpen;
            const overlay = document.getElementById("hp-search-overlay");
            const toggle = document.getElementById("hp-search-toggle");
            if (overlay)
                overlay.hidden = !nodeSearchOpen;
            toggle?.setAttribute("aria-expanded", String(nodeSearchOpen));
            if (nodeSearchOpen)
                document.getElementById("hp-node-search")?.focus();
        });
        // Pagination
        document.querySelectorAll("[data-page]").forEach((btn) => {
            btn.addEventListener("click", () => {
                const page = parseInt(btn.dataset.page);
                if (!isNaN(page)) {
                    nodeListPage = page;
                    renderUI(false);
                }
            });
        });
        // Typing only edits the native input; search runs exclusively on button click.
        document.getElementById("hp-node-search-submit")?.addEventListener("click", () => {
            const input = document.getElementById("hp-node-search");
            nodeSearchDraft = input?.value ?? "";
            nodeSearchQuery = nodeSearchDraft.trim();
            nodeListPage = 0;
            void renderUI(false);
        });
        const searchClearBtn = document.getElementById("hp-node-search-clear");
        if (searchClearBtn) {
            searchClearBtn.addEventListener("click", () => {
                nodeSearchQuery = "";
                nodeSearchDraft = "";
                const input = document.getElementById("hp-node-search");
                if (input)
                    input.value = "";
                nodeListPage = 0;
                renderUI();
            });
        }
        document.getElementById("hp-toggle-card-edit-mode")?.addEventListener("click", safeAsync(async () => {
            const scrollTop = document.getElementById("hp-body")?.scrollTop ?? 0;
            if (cardInlineEditMode)
                await flushInlineCardChanges();
            cardInlineEditMode = !cardInlineEditMode;
            selectedMemoryEntries.clear();
            await renderUI(true, scrollTop);
        }, "toggle-card-edit-mode"));
        document.querySelectorAll(".hp-entry-select").forEach(checkbox => {
            const entry = state.entries[Number(checkbox.dataset.entryPosition)];
            checkbox.addEventListener("change", () => {
                if (!entry || !state.entries.includes(entry))
                    return;
                if (checkbox.checked)
                    selectedMemoryEntries.add(entry);
                else
                    selectedMemoryEntries.delete(entry);
                const count = getSelectedMemoryEntries().length;
                const label = document.getElementById("hp-entry-selection-count");
                if (label)
                    label.textContent = `${count}개 선택`;
                const deleteButton = document.getElementById("hp-delete-selected-entries");
                const mergeButton = document.getElementById("hp-merge-selected-entries");
                if (deleteButton)
                    deleteButton.disabled = count === 0;
                if (mergeButton)
                    mergeButton.disabled = count < 2;
            });
        });
        document.getElementById("hp-delete-selected-entries")?.addEventListener("click", safeAsync(() => applySelectedEntryAction("delete"), "delete-selected-entries"));
        document.getElementById("hp-merge-selected-entries")?.addEventListener("click", safeAsync(() => applySelectedEntryAction("merge"), "merge-selected-entries"));
        // Card-local editing uses the card's reading surfaces themselves. Values
        // update in memory immediately and are persisted after a quiet interval.
        if (cardInlineEditMode) {
            const editorState = state;
            const inlineEditors = Array.from(document.querySelectorAll(".hp-card-inline-content, .hp-card-inline-time"));
            const editableText = (element) => element instanceof HTMLInputElement
                ? element.value
                : element.innerText.replace(/\u00a0/g, " ");
            for (const editor of inlineEditors) {
                const nodeId = editor.dataset.nodeId;
                const node = findNodeById(nodeId);
                if (!node)
                    continue;
                // Compare with the rendered surface, not a serialization of untouched
                // rich text. Editing a title never rewrites its content or translation.
                let previousValue = editableText(editor);
                const applyChangedEditor = () => {
                    if (state !== editorState || findNodeById(nodeId) !== node)
                        return;
                    const value = editableText(editor);
                    if (value === previousValue)
                        return;
                    previousValue = value;
                    const field = editor.classList.contains("hp-card-inline-time") ? "time"
                        : editor.closest(".hp-card-inline-editor")?.dataset.inlineKind === "translation" ? "translation" : "content";
                    if (field === "translation" && (!node.translation || node.translation.content === value)) return;
                    const next = field === "time" ? normalizeTimeString(value)
                        : field === "translation" ? { ...node.translation, content: value, manuallyEdited: true, updatedAt: Date.now() }
                        : value;
                    editMemory(node, { [field]: next }, { history: true });
                };
                editor.addEventListener("input", applyChangedEditor);
                editor.addEventListener("blur", applyChangedEditor);
            }
            document.querySelectorAll(".hp-memory-undo, .hp-memory-redo").forEach(button => {
                button.addEventListener("pointerdown", event => event.preventDefault());
                button.addEventListener("click", safeAsync(() => applyMemoryHistory(button.classList.contains("hp-memory-redo")), "memory-history"));
            });
            updateMemoryHistoryButtons();
        }
        // Toggle between all nodes and the union of chosen plus recent memory.
        const toggleChosenNodesOnly = safeAsync(async () => {
            showChosenNodesOnly = !showChosenNodesOnly;
            nodeListPage = 0;
            renderUI(false);
        }, "chosen-node-filter");
        document
            .querySelectorAll("#hp-chosen-stat-toggle")
            .forEach((toggle) => toggle.addEventListener("click", toggleChosenNodesOnly));
        // Switch between chronological and reverse-chronological node ordering.
        const nodeSortSelect = document.getElementById("hp-node-sort");
        if (nodeSortSelect) {
            nodeSortSelect.addEventListener("change", safeAsync(async () => {
                nodeSortDirection = nodeSortSelect.value === "tokens-desc" ? "tokens-desc" : nodeSortSelect.value === "desc" ? "desc" : "asc";
                nodeListPage = 0;
                await saveSettings();
                renderUI(false);
            }, "node-sort-direction"));
        }
        const nodesPerPageSelect = document.getElementById("hp-nodes-per-page");
        if (nodesPerPageSelect) {
            nodesPerPageSelect.addEventListener("change", safeAsync(async () => {
                const value = Number(nodesPerPageSelect.value);
                nodesPerPage = value === 10 || value === 20 ? value : 30;
                nodeListPage = 0;
                await saveSettings();
                renderUI(false);
            }, "nodes-per-page"));
        }
        // Force summarize (both buttons) — opens dialog with warning
        document.querySelectorAll("#hp-force-summarize").forEach((btn) => {
            btn.addEventListener("click", safeAsync(async () => {
                if (pendingMessages.length === 0) {
                    alert("No pending messages to summarize.");
                    return;
                }
                const ok = await showConfirmDialog(" 수동 요약을 실행하는 동안 <b>다른 채팅방에 들어가지 마세요.</b> 데이터가 섞일 수 있습니다.<br><br>계속하시겠습니까?");
                if (!ok)
                    return;
                showSummarizeDialog = true;
                renderUI();
            }, "force-summarize"));
        });
        // Create-node buttons in the Nodes panel and the manual Chunk #0 card.
        document.querySelectorAll("#hp-create-node, #hp-create-node-chunk0").forEach((createNodeBtn) => {
            createNodeBtn.addEventListener("click", () => {
                showCreateNodeDialog = true;
                renderUI();
            });
        });
        // Backup download
        const backupDownloadBtn = document.getElementById("hp-backup-download");
        if (backupDownloadBtn) {
            backupDownloadBtn.addEventListener("click", () => {
                if (state.entries.length === 0) {
                    alert("No data to backup. Chat more to generate summaries first!");
                    return;
                }
                downloadBackup();
            });
        }
        const retrievalDebugExportBtn = document.getElementById("hp-export-retrieval-debug");
        if (retrievalDebugExportBtn) {
            retrievalDebugExportBtn.addEventListener("click", safeAsync(async () => {
                const report = await buildRetrievalDebugExport();
                await downloadJsonFile(report, "hypirk_retrieval_history");
            }, "export-retrieval-debug"));
        }
        const setFullChatDebugCopyBtn = document.getElementById("hp-copy-setfullchat-debug");
        if (setFullChatDebugCopyBtn) {
            setFullChatDebugCopyBtn.addEventListener("click", safeAsync(async () => {
                const report = await buildSetFullChatDebugReport();
                const copied = await copyTextToClipboard(JSON.stringify(report, null, 2));
                alert(copied
                    ? "setFullChat 디버그 로그를 복사했습니다."
                    : "클립보드 복사에 실패했습니다.");
            }, "copy-setfullchat-debug"));
        }
        const backupRestoreBtn = document.getElementById("hp-backup-restore");
        const restoreFileInput = document.getElementById("hp-restore-file");
        if (backupRestoreBtn && restoreFileInput) {
            backupRestoreBtn.addEventListener("click", () => {
                restoreFileInput.click();
            });
            restoreFileInput.addEventListener("change", safeAsync(async () => {
                const file = restoreFileInput.files?.[0];
                if (!file)
                    return;
                try {
                    const json = await file.text();
                    const backup = parseBackupFile(json);
                    if (!backup) {
                        alert("형식이 올바르지 않습니다. 현재 Hypirk MemoryEntry JSON을 선택해주세요.");
                        return;
                    }
                    const memoryCount = backup.data.entries.filter(entry => entry.memory !== null).length;
                    const entryCount = backup.data.entries.length;
                    if (!await showConfirmDialog(`기억 ${memoryCount}개 / 엔트리 ${entryCount}개를 불러올까요?\n현재 엔트리를 덮어씁니다.`))
                        return;
                    await restoreFromBackup(backup);
                    nodeListPage = 0;
                    alert(`Hypirk 백업을 불러왔습니다. 기억 ${memoryCount}개 / 엔트리 ${entryCount}개`);
                    invalidateUiSessionRenderData();
                    await renderUI();
                }
                catch (error) {
                    alert(`백업을 불러오지 못했습니다. ${String(error)}`);
                }
                finally {
                    // Reset file input so the same file can be re-selected
                    restoreFileInput.value = "";
                }
            }, "backup-restore"));
        }
        // Clear memory (both buttons) — custom confirm (iframe-safe)
        document.querySelectorAll("#hp-clear-memory, #hp-clear-memory2").forEach((btn) => {
            btn.addEventListener("click", safeAsync(async () => {
                const ok1 = await showConfirmDialog(" 모든 엔트리를 지웁니까? 이 동작은 되돌릴 수 없습니다.");
                if (!ok1)
                    return;
                const ok2 = await showConfirmDialog(" 정말 확실합니까? 모든 요약 데이터가 지워집니다.");
                if (!ok2)
                    return;
                state = createEmptyState();
                markEmbeddingCacheDirty();
                markDerivedCacheDirty();
                await saveState();
                nodeListPage = 0;
                invalidateUiSessionRenderData();
                await renderUI();
            }, "clear-memory"));
        });
        document.querySelectorAll(".hp-metadata-button:not(#hp-create-metadata)").forEach(button => {
            button.addEventListener("click", safeAsync(async () => {
                const node = findNodeById(button.dataset.nodeId ?? "");
                if (node)
                    await showMemoryMetadataDialog(node);
            }, "memory-metadata"));
        });
        document.querySelectorAll(".hp-activation-button").forEach(button => {
            button.addEventListener("click", safeAsync(async () => {
                const node = findNodeById(button.dataset.nodeId ?? "");
                if (node)
                    await showActivationCuesDialog(node);
            }, "memory-activation-cues"));
        });
        // Memory-card hamburger menu.
        document.querySelectorAll(".hp-node-menu-button").forEach((button) => {
            button.addEventListener("click", (event) => {
                event.stopPropagation();
                const wrap = button.closest(".hp-node-menu-wrap");
                const menu = wrap?.querySelector(".hp-node-menu-popover");
                const opening = menu?.hidden ?? true;
                document.querySelectorAll(".hp-node-menu-popover").forEach((item) => {
                    item.hidden = true;
                });
                document.querySelectorAll(".hp-node-menu-button").forEach((item) => {
                    item.setAttribute("aria-expanded", "false");
                });
                if (menu)
                    menu.hidden = !opening;
                button.setAttribute("aria-expanded", String(opening));
            });
        });
        document.querySelectorAll(".hp-node-reroll").forEach((button) => {
            button.addEventListener("click", safeAsync(async (event) => {
                event?.stopPropagation();
                const nodeId = button.dataset.nodeId;
                if (!nodeId)
                    return;
                const ok = await rerollMemoryNode(nodeId);
                if (ok)
                    await renderUI(true);
            }, "reroll-memory-node"));
        });
        document.querySelectorAll(".hp-node-lorebook-placeholder").forEach((button) => {
            button.addEventListener("click", (event) => {
                event.stopPropagation();
                // Reserved for future node-level lorebook export.
            });
        });
        // Favorite node toggle
        document.querySelectorAll(".hp-fav-node").forEach((btn) => {
            btn.addEventListener("click", safeAsync(async () => {
                const nodeId = btn.dataset.nodeId;
                const node = findNodeById(nodeId);
                if (!node)
                    return;
                await commitMemoryEdit(node, { favorite: !node.favorite });
                renderUI();
            }, "fav-node"));
        });
        // 좋아요 is independent from favorites: it adds a decaying retrieval bonus for four days.
        document.querySelectorAll(".hp-like-node").forEach((btn) => {
            btn.addEventListener("click", safeAsync(async () => {
                const nodeId = btn.dataset.nodeId;
                const node = findNodeById(nodeId);
                if (!node)
                    return;
                await commitMemoryEdit(node, { likedAt: getLikeRemaining(node) > 0 ? undefined : Date.now() });
                renderUI();
            }, "like-node"));
        });
        const translateNode = (node) => withChatOperation(async owner => {
            if (translatingNodeIds.has(node.id))
                return;
            translatingNodeIds.add(node.id);
            await renderTranslationUI();
            try {
                const sourceContent = node.content;
                const translation = await requestNodeTranslation(node);
                if (!isCurrentOperation(owner) || findNodeById(node.id) !== node || node.content !== sourceContent)
                    return;
                editMemory(node, { translation }, { deferred: false });
                setNodeTranslationVisible(node.id, true);
                await saveState();
            }
            catch (error) {
                alert(error instanceof Error ? error.message : String(error));
            }
            finally {
                translatingNodeIds.delete(node.id);
                await renderTranslationUI();
            }
        });
        document.querySelectorAll(".hp-toggle-node-translation").forEach((btn) => {
            btn.addEventListener("click", safeAsync(async () => {
                const node = findNodeById(btn.dataset.nodeId);
                if (!node)
                    return;
                if (!node.translation) {
                    await translateNode(node);
                    return;
                }
                setNodeTranslationVisible(node.id, !isNodeTranslationVisible(node.id));
                await saveState();
                await renderTranslationUI();
            }, "toggle-node-translation"));
        });
        document.querySelectorAll(".hp-node-translation-regenerate").forEach((btn) => {
            btn.addEventListener("click", safeAsync(async () => {
                const node = findNodeById(btn.dataset.nodeId);
                if (!node?.translation)
                    return;
                const ok = await showConfirmDialog("현재 원문을 기준으로 번역문을 다시 생성할까요?");
                if (!ok)
                    return;
                await translateNode(node);
            }, "regenerate-node-translation"));
        });
        // Delete node — custom confirm
        document.querySelectorAll(".hp-delete-node").forEach((btn) => {
            btn.addEventListener("click", safeAsync(async () => {
                const nodeId = btn.dataset.nodeId;
                const ok = await showConfirmDialog("이 노드를 지웁니까?");
                if (!ok)
                    return;
                removeNodeById(nodeId);
                await saveState();
                renderUI();
            }, "delete-node"));
        });
        // Memory cards expand their linked messages in place instead of opening a popup.
        document.querySelectorAll(".hp-view-node-msgs").forEach((details) => {
            details.addEventListener("toggle", safeAsync(async () => {
                if (!details.open) {
                    const closedViewer = details.closest(".hp-card, .hp-empty-entry-row")?.querySelector(".hp-node-message-viewer");
                    if (closedViewer) {
                        delete closedViewer.dataset.loaded;
                        closedViewer.innerHTML = "";
                    }
                    return;
                }
                if (details.classList.contains("hp-orphan-disabled")) {
                    details.open = false;
                    return;
                }
                const viewer = details.closest(".hp-card, .hp-empty-entry-row")?.querySelector(".hp-node-message-viewer");
                if (!viewer || viewer.dataset.loaded === "true")
                    return;
                const chunk = state.entries[Number(details.dataset.entryPosition)];
                if (!chunk)
                    return;
                try {
                    const viewerData = await loadChunkViewerData(chunk);
                    if (!viewerData) {
                        details.open = false;
                        alert("Cannot fetch MemoryEntry messages.");
                        return;
                    }
                    viewer.dataset.loaded = "true";
                    mountChunkMessageViewer(viewer, viewerData.title, viewerData.messages, true, () => {
                        details.open = false;
                        delete viewer.dataset.loaded;
                        viewer.innerHTML = "";
                    }, async () => {
                        const ok = await summarizeMemoryEntry(chunk);
                        if (!ok)
                            return;
                        details.open = false;
                        delete viewer.dataset.loaded;
                        viewer.innerHTML = "";
                        await renderUI(true);
                    });
                }
                catch (e) {
                    details.open = false;
                    console.log("[Hypirk] Failed to fetch node source messages:", e);
                    alert("Failed to fetch MemoryEntry messages.");
                }
            }, "view-node-msgs"));
        });
        const editEntriesBtn = document.getElementById("hp-edit-entries");
        if (editEntriesBtn) {
            editEntriesBtn.addEventListener("click", safeAsync(async () => {
                await showMemoryEntryEditor();
            }, "edit-source-groups"));
        }
        // Storage controls.
        const viewStorageDataBtn = document.getElementById("hp-view-storage-data");
        const importHypaV3DataBtn = document.getElementById("hp-import-hypav3-data");
        if (viewStorageDataBtn) {
            viewStorageDataBtn.addEventListener("click", safeAsync(async () => {
                await showStorageDataManagerDialog();
            }, "view-storage-data"));
        }
        if (importHypaV3DataBtn) {
            importHypaV3DataBtn.addEventListener("click", safeAsync(async () => {
                await importCurrentChatHypaV3Data();
                await renderUI(true);
            }, "import-hypav3-data"));
        }
        // Test Embedding button — runs full retrieval and displays scores
        const testEmbBtn = document.getElementById("hp-test-embedding");
        if (testEmbBtn) {
            testEmbBtn.addEventListener("click", safeAsync(async () => {
                if (!embeddingUrl) {
                    alert("No embedding URL configured. Set it in Settings first.");
                    return;
                }
                // Build embedding and Dialogue-local inputs from the same recent messages.
                const retrievalInputs = await buildRetrievalInputs();
                if (!retrievalInputs.embeddingQuery) {
                    alert("No chat messages available to build embedding query.");
                    return;
                }
                // Run retrieval
                await withChatOperation(async owner => {
                    const result = await retrieveRelevantNodes(retrievalInputs.embeddingQuery, maxMemoryTokens, retrievalInputs.dialogueLines, new Set(), retrievalInputs.embeddingQueries, retrievalInputs.querySources);
                    if (!isCurrentOperation(owner)) return;
                    applyRetrievalResult(result);
                    await appendCompactRetrievalLedgerRows(result.ledgerRows);
                    await saveState();
                });
                // Switch to nodes tab to show results
                activeTab = "nodes";
                // This is a cross-tab result view: start at the top instead of
                // carrying the Settings panel's numeric scrollTop into the node list.
                renderUI(false);
            }, "test-embedding"));
        }
        const clearNodeEmbeddingCacheBtn = document.getElementById("hp-clear-node-embedding-cache");
        if (clearNodeEmbeddingCacheBtn) {
            clearNodeEmbeddingCacheBtn.addEventListener("click", safeAsync(async () => {
                if (!await showConfirmDialog("현재 채팅의 저장된 노드 벡터를 모두 지울까요?<br>다음 임베딩 검색 때 필요한 벡터를 다시 생성합니다.")) {
                    return;
                }
                let clearedNodes = 0;
                for (const node of getNodes()) {
                    const hadCache = hasAnyEmbeddingCache(node);
                    if (!hadCache)
                        continue;
                    clearNodeEmbedding(node);
                    clearedNodes += 1;
                }
                if (clearedNodes > 0)
                    await saveState();
                alert(clearedNodes > 0
                    ? `노드 ${clearedNodes}개의 임베딩 캐시를 초기화했습니다.`
                    : "초기화할 노드 임베딩 캐시가 없습니다.");
                renderUI();
            }, "clear-node-embedding-cache"));
        }
        // Summarize dialog: cancel
        const summarizeCancelBtn = document.getElementById("hp-summarize-cancel");
        if (summarizeCancelBtn) {
            summarizeCancelBtn.addEventListener("click", () => {
                showSummarizeDialog = false;
                renderUI();
            });
        }
        // Summarize dialog: confirm
        const summarizeConfirmBtn = document.getElementById("hp-summarize-confirm");
        if (summarizeConfirmBtn) {
            summarizeConfirmBtn.addEventListener("click", safeAsync(async () => {
                const numChunks = parseInt(document.getElementById("hp-summarize-chunks").value) ||
                    1;
                showSummarizeDialog = false;
                manualSummarizationInProgress = true;
                try {
                    await renderUI();
                    for (let i = 0; i < numChunks; i++) {
                        await runSummarization(chunkSize, "ui-manual");
                    }
                }
                finally {
                    manualSummarizationInProgress = false;
                    await renderUI();
                }
            }, "summarize-confirm"));
        }
        // Create-node overlay keeps its existing local editor helpers. Existing-memory
        // editing now happens directly on the memory card.
        function attachNodeContentEditorTools(prefix, contentInput) {
            const snapshots = [
                { value: contentInput.value, start: 0, end: 0 },
            ];
            let snapshotIndex = 0;
            let snapshotTimer = null;
            let applyingSnapshot = false;
            const currentSnapshot = () => ({
                value: contentInput.value,
                start: contentInput.selectionStart ?? 0,
                end: contentInput.selectionEnd ?? 0,
            });
            const commitSnapshot = () => {
                if (snapshotTimer !== null)
                    window.clearTimeout(snapshotTimer);
                snapshotTimer = null;
                const next = currentSnapshot();
                if (snapshots[snapshotIndex]?.value === next.value)
                    return;
                snapshots.splice(snapshotIndex + 1);
                snapshots.push(next);
                snapshotIndex = snapshots.length - 1;
            };
            const applySnapshot = (snapshot) => {
                applyingSnapshot = true;
                contentInput.value = snapshot.value;
                contentInput.focus();
                contentInput.setSelectionRange(snapshot.start, snapshot.end);
                contentInput.dispatchEvent(new Event("input", { bubbles: true }));
                applyingSnapshot = false;
            };
            contentInput.addEventListener("input", () => {
                if (applyingSnapshot)
                    return;
                if (snapshotTimer !== null)
                    window.clearTimeout(snapshotTimer);
                snapshotTimer = window.setTimeout(commitSnapshot, 350);
            });
            document.getElementById(`hp-${prefix}-undo`)?.addEventListener("click", () => {
                commitSnapshot();
                if (snapshotIndex <= 0)
                    return;
                snapshotIndex -= 1;
                applySnapshot(snapshots[snapshotIndex]);
            });
            document.getElementById(`hp-${prefix}-redo`)?.addEventListener("click", () => {
                commitSnapshot();
                if (snapshotIndex >= snapshots.length - 1)
                    return;
                snapshotIndex += 1;
                applySnapshot(snapshots[snapshotIndex]);
            });
        }
        const createContentInput = document.getElementById("hp-create-content");
        if (createContentInput)
            attachNodeContentEditorTools("create", createContentInput);
        document.getElementById("hp-create-metadata")?.addEventListener("click", (event) => {
            event.preventDefault();
            showCreateMemoryMetadataDialog();
        });
        // Create node overlay: cancel
        const createCancelBtn = document.getElementById("hp-create-cancel");
        if (createCancelBtn) {
            createCancelBtn.addEventListener("click", () => {
                showCreateNodeDialog = false;
                renderUI();
            });
        }
        // Create node overlay: save
        const createSaveBtn = document.getElementById("hp-create-save");
        if (createSaveBtn) {
            createSaveBtn.addEventListener("click", safeAsync(async () => {
                const time = normalizeTimeString(document.getElementById("hp-create-time").value);
                const content = document.getElementById("hp-create-content").value.trim();
                const linkedMessagesValue = document.getElementById("hp-create-linked-messages").value;
                const linkedMessages = parseLinkedMessageIndexes(linkedMessagesValue);
                if (!time || !content) {
                    alert("시간과 내용은 필수 입력 항목입니다.");
                    return;
                }
                if (linkedMessages === null) {
                    alert("연결 메시지 인덱스를 확인해주세요. 예: 5, 8-11, #14");
                    return;
                }
                const tags = document.getElementById("hp-create-tags").value
                    .split(",").map((tag) => tag.trim()).filter(Boolean);
                const category = document.getElementById("hp-create-category").value.trim() || undefined;
                const activationCues = document.getElementById("hp-create-activation-cues").value
                    .split(",").map((cue) => cue.trim()).filter(Boolean);
                const node = {
                    id: nextNodeId(),
                    time,
                    category,
                    tags,
                    content,
                    activationCues: activationCues.length > 0 ? activationCues : undefined,
                    createdAt: Date.now(),
                };
                appendMemoryEntry(node, linkedMessages);
                await saveState();
                showCreateNodeDialog = false;
                renderUI();
            }, "create-save"));
        }
        bindToolbarMenus();
        document.querySelectorAll("[data-ui-color-preset]").forEach((option) => {
            option.addEventListener("click", safeAsync(async () => {
                const value = option.dataset.uiColorPreset;
                if (!isUiColorPreset(value) || value === uiColorPreset)
                    return;
                uiColorPreset = value;
                await saveSettings();
                await renderUI(false);
            }, "ui-color-preset"));
        });
        document.querySelectorAll("[data-ui-reading-scale]").forEach((option) => {
            option.addEventListener("click", safeAsync(async () => {
                const value = Number(option.dataset.uiReadingScale);
                if (!READING_SCALE_PRESETS.includes(value) || value === readingScale)
                    return;
                readingScale = value;
                await saveSettings();
                await renderUI(true);
            }, "ui-reading-scale"));
        });
        document.querySelectorAll("[data-ui-reading-font]").forEach((option) => {
            option.addEventListener("click", safeAsync(async () => {
                const value = option.dataset.uiReadingFont;
                if (!READING_FONT_OPTIONS.some((item) => item.value === value) || value === readingFontFamily)
                    return;
                readingFontFamily = value;
                await saveSettings();
                await renderUI(true);
            }, "ui-reading-font"));
        });
        const maxTokensInput = document.getElementById("hp-max-tokens");
        const recentRatioInput = document.getElementById("hp-recent-memory-ratio");
        const updateMemoryEstimate = () => {
            if (!recentRatioInput)
                return;
            const parsedTotal = Number(maxTokensInput?.value);
            const total = Number.isFinite(parsedTotal) ? Math.max(0, parsedTotal) : 0;
            const recentPercent = Math.max(0, Math.min(100, Number(recentRatioInput.value) || 0));
            const estimate = estimateMemoryBudget(total, recentPercent / 100);
            recentRatioInput.style.setProperty("--hp-memory-split", `${recentPercent}%`);
            const recentPercentEl = document.getElementById("hp-recent-memory-percent");
            const chosenPercentEl = document.getElementById("hp-chosen-memory-percent");
            const recentEstimateEl = document.getElementById("hp-recent-memory-estimate");
            const chosenEstimateEl = document.getElementById("hp-chosen-memory-estimate");
            if (recentPercentEl)
                recentPercentEl.textContent = `${recentPercent}%`;
            if (chosenPercentEl)
                chosenPercentEl.textContent = `${100 - recentPercent}%`;
            if (recentEstimateEl) {
                recentEstimateEl.textContent =
                    `예상 ${estimate.recentBudget}토큰 · 최근 메모리 ${estimate.recentNodeCount}개`;
            }
            if (chosenEstimateEl)
                chosenEstimateEl.textContent = `예상 ${estimate.chosenBudget}토큰`;
        };
        let ratioPointerAccepted = true;
        let ratioPointerStartValue = recentRatioInput?.value ?? "";
        recentRatioInput?.addEventListener("input", () => {
            if (!ratioPointerAccepted)
                recentRatioInput.value = ratioPointerStartValue;
            updateMemoryEstimate();
        });
        maxTokensInput?.addEventListener("input", updateMemoryEstimate);
        updateMemoryEstimate();
        recentRatioInput?.addEventListener("pointerdown", (event) => {
            ratioPointerStartValue = recentRatioInput.value;
            const rect = recentRatioInput.getBoundingClientRect();
            const min = Number(recentRatioInput.min) || 0;
            const max = Number(recentRatioInput.max) || 100;
            const value = Number(recentRatioInput.value) || 0;
            const ratio = max > min ? (value - min) / (max - min) : 0;
            const thumbCenter = rect.left + ratio * rect.width;
            ratioPointerAccepted = Math.abs(event.clientX - thumbCenter) <= 14;
            if (!ratioPointerAccepted) {
                event.preventDefault();
            }
        });
        recentRatioInput?.addEventListener("click", (event) => {
            if (ratioPointerAccepted)
                return;
            event.preventDefault();
            recentRatioInput.value = ratioPointerStartValue;
            updateMemoryEstimate();
            ratioPointerAccepted = true;
        });
        const testNodeTranslationApiButton = document.getElementById("hp-test-node-translation-api");
        if (testNodeTranslationApiButton) {
            testNodeTranslationApiButton.addEventListener("click", safeAsync(async () => {
                const url = document.getElementById("hp-node-translation-url").value.trim();
                const key = document.getElementById("hp-node-translation-key").value.trim();
                const model = document.getElementById("hp-node-translation-model").value.trim();
                if (!url || !model) {
                    alert("API URL과 모델명을 입력해주세요.");
                    return;
                }
                const headers = { "Content-Type": "application/json" };
                if (key)
                    headers.Authorization = `Bearer ${key}`;
                testNodeTranslationApiButton.disabled = true;
                testNodeTranslationApiButton.textContent = "확인 중…";
                try {
                    const response = await risuai.nativeFetch(url, {
                        method: "POST",
                        headers,
                        body: JSON.stringify({
                            model,
                            messages: [{ role: "user", content: "Reply with OK only." }],
                            temperature: 0,
                            max_tokens: 8,
                        }),
                    });
                    if (!response.ok)
                        throw new Error(`HTTP ${response.status}`);
                    const data = await response.json();
                    if (typeof data?.choices?.[0]?.message?.content !== "string") {
                        throw new Error("OpenAI 호환 응답 형식이 아닙니다.");
                    }
                    alert("노드 번역 API 연결에 성공했습니다.");
                }
                catch (error) {
                    alert(`연결 테스트 실패: ${error instanceof Error ? error.message : String(error)}`);
                }
                finally {
                    testNodeTranslationApiButton.disabled = false;
                    testNodeTranslationApiButton.textContent = "연결 테스트";
                }
            }, "test-node-translation-api"));
        }
        // Character-specific RP date parsing. Preview is computed only while this UI is open.
        const timelineRegexInput = document.getElementById("hp-timeline-date-regex");
        const timelineRegexFlagsInput = document.getElementById("hp-timeline-date-regex-flags");
        const timelineCaptureGroupInput = document.getElementById("hp-timeline-date-capture-group");
        const timelinePreviewDate = document.querySelector(".hp-date-parser-current");
        const readTimelineSettingsInputs = () => {
            const captureGroup = Number.parseInt(timelineCaptureGroupInput?.value ?? "1", 10);
            return {
                timelineDateRegex: timelineRegexInput?.value ?? "",
                timelineDateRegexFlags: timelineRegexFlagsInput?.value ?? "",
                dateCaptureGroup: Number.isInteger(captureGroup) ? Math.max(0, captureGroup) : 1,
            };
        };
        const updateTimelinePreview = () => {
            const detection = detectCurrentTimelineDate(readTimelineSettingsInputs());
            if (timelinePreviewDate)
                timelinePreviewDate.textContent = detection?.rawDate ?? "—";
        };
        let timelinePreviewTimer = null;
        const scheduleTimelinePreview = () => {
            if (timelinePreviewTimer !== null)
                window.clearTimeout(timelinePreviewTimer);
            timelinePreviewTimer = window.setTimeout(() => {
                timelinePreviewTimer = null;
                updateTimelinePreview();
            }, 120);
        };
        [timelineRegexInput, timelineRegexFlagsInput, timelineCaptureGroupInput].forEach((input) => {
            input?.addEventListener("input", scheduleTimelinePreview);
        });
        document.getElementById("hp-save-timeline-parser")?.addEventListener("click", safeAsync(async () => {
            currentCharacterTimelineSettings = readTimelineSettingsInputs();
            settingsHelpSequence = 0;
            currentUiTimelineDetection = detectCurrentTimelineDate();
            await saveCurrentCharacterTimelineSettings();
            await renderUI(true);
        }, "save-timeline-parser"));
        const debugModeInput = document.getElementById("hp-debug-mode");
        debugModeInput?.addEventListener("change", safeAsync(async () => {
            debugMode = debugModeInput.checked;
            debugModeInput.closest('[role="menuitemcheckbox"]')?.setAttribute("aria-checked", String(debugMode));
            await saveSettings();
            await renderUI(true);
        }, "debug-mode"));
        // Commit only the requested scope; search controls never participate in autosave.
        const commitPresetSettings = async () => {
            if (!PRESET_FIELDS.some(id => settingsEdits.has(id)))
                return true;
            if (!validateSettingsNumbers(PRESET_FIELDS))
                return false;
            const previous = currentSettingsAsPreset();
            try {
                readPresetSettingsFromUI();
                await updateActivePresetFields({ summaryPrompt, chunkSize, retainedMessagesAfterSummary,
                    includeUserMessages, embeddingContextMessages, maxMemoryTokens, recentMemoryRatio,
                    memorySeparator, eventFormat });
                await savePrompt();
                await saveSettings();
            }
            catch (error) {
                applyPreset(previous);
                throw error;
            }
            clearSettingsEdits(PRESET_FIELDS);
            clearTokenCache();
            return true;
        };
        const commitSettingsBoundary = async () => {
            if (settingsBoundaryBusy)
                return false;
            if (settingsDraftContextKey !== getUiContextKey()) {
                alert("채팅이 변경되었습니다. 설정 창을 다시 열어주세요.");
                return false;
            }
            settingsBoundaryBusy = true;
            try {
                if (!validateSettingsNumbers([...PRESET_FIELDS, ...COMMON_FIELDS]))
                    return false;
                // Resolve namespace collisions before committing any other scope.
                if (!(await commitInjectionSettings()))
                    return false;
                if (!(await commitPresetSettings()))
                    return false;
                const text = (id) => document.getElementById(id)?.value ?? "";
                if (COMMON_FIELDS.some(id => settingsEdits.has(id))) {
                    const previous = { embeddingUrl, embeddingModel, embeddingApiKey, nodeTranslationApiUrl,
                        nodeTranslationApiKey, nodeTranslationModel, nodeTranslationLanguage, nodeTranslationPrompt,
                        nodeTranslationMaxTokens, nodeTranslationTemperature, note: state.summarizerNote };
                    try {
                        embeddingUrl = text("hp-embedding-url").trim();
                        embeddingModel = text("hp-embedding-model").trim();
                        embeddingApiKey = text("hp-embedding-api-key").trim();
                        nodeTranslationApiUrl = text("hp-node-translation-url").trim();
                        nodeTranslationApiKey = text("hp-node-translation-key").trim();
                        nodeTranslationModel = text("hp-node-translation-model").trim();
                        nodeTranslationLanguage = text("hp-node-translation-language").trim() || "한국어";
                        nodeTranslationPrompt = text("hp-node-translation-prompt").trim() || DEFAULT_NODE_TRANSLATION_PROMPT;
                        nodeTranslationMaxTokens = Number(text("hp-node-translation-max-tokens"));
                        nodeTranslationTemperature = Number(text("hp-node-translation-temperature"));
                        state.summarizerNote = text("hp-summarizer-note");
                        await saveSettings();
                        await saveState();
                    }
                    catch (error) {
                        ({ embeddingUrl, embeddingModel, embeddingApiKey, nodeTranslationApiUrl,
                            nodeTranslationApiKey, nodeTranslationModel, nodeTranslationLanguage, nodeTranslationPrompt,
                            nodeTranslationMaxTokens, nodeTranslationTemperature } = previous);
                        state.summarizerNote = previous.note;
                        throw error;
                    }
                    clearSettingsEdits(COMMON_FIELDS);
                }
                const draft = getRegexSettingsDraft();
                if (draft.dirty) {
                    const previousRules = regexLibraryCache;
                    const previousIds = state.regexRuleIds;
                    try {
                        regexLibraryCache = JSON.parse(JSON.stringify(draft.rules));
                        state.regexRuleIds = [...draft.ids];
                        await saveRegexLibrary();
                        await saveState();
                    }
                    catch (error) {
                        regexLibraryCache = previousRules;
                        state.regexRuleIds = previousIds;
                        throw error;
                    }
                    draft.dirty = false;
                }
                return true;
            }
            finally {
                settingsBoundaryBusy = false;
            }
        };
        document.getElementById("hp-save-search-settings")?.addEventListener("click", safeAsync(async () => {
            if (!validateSettingsNumbers(SEARCH_FIELDS, false))
                return;
            const number = (id) => Number(document.getElementById(id).value);
            const next = SEARCH_FIELDS.map(number);
            const previous = [queryParagraphGroupSize, dialogueEmbeddingWeight, dialogueLocalWeight, activationCueWeight, likeBonusBase];
            const changed = next.some((value, index) => value !== previous[index]);
            [queryParagraphGroupSize, dialogueEmbeddingWeight, dialogueLocalWeight, activationCueWeight, likeBonusBase] = next;
            try {
                await saveSettings();
                if (changed) {
                    state.lastNodeScores = {};
                    state.lastChosenNodeIds = [];
                    state.lastRecentNodeIds = [];
                    lastEmbeddingRetrievalTrace = null;
                    markDerivedCacheDirty();
                    await saveState();
                }
            }
            catch (error) {
                [queryParagraphGroupSize, dialogueEmbeddingWeight, dialogueLocalWeight, activationCueWeight, likeBonusBase] = previous;
                throw error;
            }
            clearSettingsEdits(SEARCH_FIELDS);
            const status = document.getElementById("hp-search-save-status");
            if (status)
                status.textContent = "Query 문단 묶음과 검색 신호를 저장했습니다.";
        }, "save-search-settings", { settingsAction: true }));
        // Main-model memory injection namespace profiles.
        const injectionProfileSelect = document.getElementById("hp-memory-injection-profile-select");
        const readMemoryInjectionProfileFromUI = () => ({
            namespace: normalizeMemoryInjectionNamespace(document.getElementById("hp-memory-injection-namespace")?.value ?? ""),
            anchor: document.getElementById("hp-memory-injection-anchor")?.value ?? DEFAULT_MEMORY_INJECTION_ANCHOR,
            template: document.getElementById("hp-memory-injection-template")?.value ?? DEFAULT_MEMORY_INJECTION_TEMPLATE,
        });
        const populateMemoryInjectionProfileSelect = () => {
            if (!injectionProfileSelect)
                return;
            const options = memoryInjectionProfilesCache.map((profile) => `<option value="${escapeHtml(profile.id)}" ${!memoryInjectionDraft && profile.id === activeMemoryInjectionProfileId ? "selected" : ""}>${escapeHtml(memoryInjectionProfileLabel(profile.namespace))}</option>`);
            if (memoryInjectionDraft) {
                options.push(`<option value="__draft__" selected>${escapeHtml(memoryInjectionProfileLabel(memoryInjectionDraft.namespace))} · 새 설정</option>`);
            }
            injectionProfileSelect.innerHTML = options.length
                ? options.join("")
                : `<option value="">저장된 주입 설정 없음</option>`;
        };
        populateMemoryInjectionProfileSelect();
        injectionProfileSelect?.addEventListener("change", safeAsync(async () => {
            const nextProfileId = injectionProfileSelect.value;
            if (!(await commitInjectionSettings())) {
                populateMemoryInjectionProfileSelect();
                return;
            }
            if (nextProfileId === "__draft__" && memoryInjectionDraft) {
                applyMemoryInjectionProfile(memoryInjectionDraft);
                await renderUI(true);
                return;
            }
            const selected = memoryInjectionProfilesCache.find((profile) => profile.id === nextProfileId);
            if (!selected)
                return;
            memoryInjectionDraft = null;
            activeMemoryInjectionProfileId = selected.id;
            applyMemoryInjectionProfile(selected);
            await saveSettings();
            await renderUI(true);
        }, "select-memory-injection-profile", { settingsAction: true }));
        document.getElementById("hp-add-memory-injection-profile")?.addEventListener("click", safeAsync(async () => {
            if (!(await commitInjectionSettings()))
                return;
            memoryInjectionDraft = {
                id: "__draft__",
                mode: "add",
                namespace: "",
                anchor: DEFAULT_MEMORY_INJECTION_ANCHOR,
                template: DEFAULT_MEMORY_INJECTION_TEMPLATE,
            };
            clearSettingsEdits(INJECTION_FIELDS);
            await renderUI(true);
        }, "add-memory-injection-profile", { settingsAction: true }));
        document.getElementById("hp-copy-memory-injection-profile")?.addEventListener("click", safeAsync(async () => {
            if (!(await commitInjectionSettings()))
                return;
            const source = readMemoryInjectionProfileFromUI();
            memoryInjectionDraft = {
                id: "__draft__",
                mode: "copy",
                namespace: "",
                anchor: source.anchor,
                template: source.template,
            };
            clearSettingsEdits(INJECTION_FIELDS);
            await renderUI(true);
        }, "copy-memory-injection-profile", { settingsAction: true }));
        const commitInjectionSettings = async () => {
            if (!memoryInjectionDraft && !INJECTION_FIELDS.some(id => settingsEdits.has(id)))
                return true;
            const previousProfiles = JSON.parse(JSON.stringify(memoryInjectionProfilesCache));
            const previousId = activeMemoryInjectionProfileId;
            const previousDraft = memoryInjectionDraft;
            const previousActive = { id: previousId, namespace: memoryInjectionNamespace, anchor: memoryInjectionAnchor, template: memoryInjectionTemplate };
            const edited = readMemoryInjectionProfileFromUI();
            const currentStoredId = memoryInjectionDraft ? null : activeMemoryInjectionProfileId;
            const duplicate = memoryInjectionProfilesCache.find((profile) => normalizeMemoryInjectionNamespace(profile.namespace) === edited.namespace &&
                profile.id !== currentStoredId);
            try {
                if (duplicate) {
                    const label = memoryInjectionProfileLabel(edited.namespace);
                    const ok = await showConfirmDialog(edited.namespace
                        ? `네임스페이스 "${label}" 설정이 이미 있습니다. 기존 설정을 덮어쓸까요?`
                        : `네임스페이스 없음(기본 fallback) 설정이 이미 있습니다. 기존 fallback을 덮어쓸까요?`);
                    if (!ok)
                        return false;
                    duplicate.namespace = edited.namespace;
                    duplicate.anchor = edited.anchor;
                    duplicate.template = edited.template;
                    if (currentStoredId && currentStoredId !== duplicate.id) {
                        memoryInjectionProfilesCache = memoryInjectionProfilesCache.filter((profile) => profile.id !== currentStoredId);
                    }
                    activeMemoryInjectionProfileId = duplicate.id;
                }
                else if (currentStoredId) {
                    const current = memoryInjectionProfilesCache.find((profile) => profile.id === currentStoredId);
                    if (current) {
                        current.namespace = edited.namespace;
                        current.anchor = edited.anchor;
                        current.template = edited.template;
                        activeMemoryInjectionProfileId = current.id;
                    }
                    else {
                        const created = {
                            id: makeMemoryInjectionProfileId(),
                            ...edited,
                        };
                        memoryInjectionProfilesCache.push(created);
                        activeMemoryInjectionProfileId = created.id;
                    }
                }
                else {
                    const created = {
                        id: makeMemoryInjectionProfileId(),
                        ...edited,
                    };
                    memoryInjectionProfilesCache.push(created);
                    activeMemoryInjectionProfileId = created.id;
                }
                memoryInjectionDraft = null;
                await saveMemoryInjectionProfiles();
                const selected = memoryInjectionProfilesCache.find((profile) => profile.id === activeMemoryInjectionProfileId);
                if (selected)
                    applyMemoryInjectionProfile(selected);
                await saveSettings();
            }
            catch (error) {
                memoryInjectionProfilesCache = previousProfiles;
                activeMemoryInjectionProfileId = previousId;
                memoryInjectionDraft = previousDraft;
                applyMemoryInjectionProfile(previousActive);
                throw error;
            }
            clearSettingsEdits(INJECTION_FIELDS);
            return true;
        };
        document.getElementById("hp-delete-memory-injection-profile")?.addEventListener("click", safeAsync(async () => {
            if (memoryInjectionDraft) {
                clearSettingsEdits(INJECTION_FIELDS);
                memoryInjectionDraft = null;
                applyInitialMemoryInjectionProfileSelection();
                await renderUI(true);
                return;
            }
            const index = memoryInjectionProfilesCache.findIndex((profile) => profile.id === activeMemoryInjectionProfileId);
            if (index < 0) {
                alert("삭제할 주입 설정이 없습니다.");
                return;
            }
            const profile = memoryInjectionProfilesCache[index];
            const ok = await showConfirmDialog(`장기기억 주입 설정 "${memoryInjectionProfileLabel(profile.namespace)}"을 삭제할까요?`);
            if (!ok)
                return;
            clearSettingsEdits(INJECTION_FIELDS);
            memoryInjectionProfilesCache.splice(index, 1);
            const next = memoryInjectionProfilesCache[Math.min(index, memoryInjectionProfilesCache.length - 1)]
                ?? memoryInjectionProfilesCache[0]
                ?? null;
            activeMemoryInjectionProfileId = next?.id ?? "";
            memoryInjectionDraft = null;
            if (next)
                applyMemoryInjectionProfile(next);
            else {
                memoryInjectionNamespace = "";
                memoryInjectionAnchor = DEFAULT_MEMORY_INJECTION_ANCHOR;
                memoryInjectionTemplate = DEFAULT_MEMORY_INJECTION_TEMPLATE;
            }
            await saveMemoryInjectionProfiles();
            await saveSettings();
            await renderUI(true);
        }, "delete-memory-injection-profile", { settingsAction: true }));
        // Prompt: reset
        const resetPromptBtn = document.getElementById("hp-reset-prompt");
        if (resetPromptBtn) {
            resetPromptBtn.addEventListener("click", async () => {
                const field = document.getElementById("hp-prompt-textarea");
                if (field) {
                    field.value = DEFAULT_SUMMARY_PROMPT;
                    field.dispatchEvent(new Event("input", { bubbles: true }));
                }
            });
        }
        // Unified summary-preset controls.
        const presetSelect = document.getElementById("hp-preset-select");
        const readPresetSettingsFromUI = () => {
            summaryPrompt = document.getElementById("hp-prompt-textarea")?.value ?? summaryPrompt;
            chunkSize = Number.parseInt(document.getElementById("hp-chunk-size")?.value ?? "", 10) || chunkSize;
            const retainedValue = Number.parseInt(document.getElementById("hp-summary-retain-messages")?.value ?? "", 10);
            if (Number.isFinite(retainedValue) && retainedValue >= 0)
                retainedMessagesAfterSummary = retainedValue;
            includeUserMessages = document.getElementById("hp-include-user")?.checked ?? includeUserMessages;
            embeddingContextMessages = Number.parseInt(document.getElementById("hp-embedding-context")?.value ?? "", 10) || embeddingContextMessages;
            maxMemoryTokens = Number.parseInt(document.getElementById("hp-max-tokens")?.value ?? "", 10) || maxMemoryTokens;
            const recentRatioPercent = Number(document.getElementById("hp-recent-memory-ratio")?.value ?? "");
            if (Number.isFinite(recentRatioPercent))
                recentMemoryRatio = Math.max(0, Math.min(1, recentRatioPercent / 100));
            eventFormat = normalizeContentOnlyEventFormat(document.getElementById("hp-event-format")?.value ?? eventFormat);
            memorySeparator = document.getElementById("hp-memory-separator")?.value ?? memorySeparator;
        };
        const populatePresetSelect = async () => {
            if (!presetSelect)
                return;
            const presets = await loadPresets();
            if (activeSummaryPresetName && !presets.some((p) => p.name === activeSummaryPresetName)) {
                activeSummaryPresetName = "";
            }
            presetSelect.innerHTML = presets.length
                ? `${activeSummaryPresetName ? "" : `<option value="" selected>현재 활성 프리셋 없음 · 기존 설정</option>`}${presets.map((p) => `<option value="${escapeHtml(p.name)}" ${p.name === activeSummaryPresetName ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}`
                : `<option value="">저장된 프리셋 없음</option>`;
        };
        void populatePresetSelect();
        presetSelect?.addEventListener("change", safeAsync(async () => {
            if (!(await commitPresetSettings())) {
                await populatePresetSelect();
                return;
            }
            const presets = await loadPresets();
            const preset = presets.find((p) => p.name === presetSelect.value);
            if (!preset)
                return;
            activeSummaryPresetName = preset.name;
            applyPreset(preset);
            await savePrompt();
            await saveSettings();
            await renderUI(true);
        }, "select-summary-preset", { settingsAction: true }));
        document.getElementById("hp-add-preset")?.addEventListener("click", safeAsync(async () => {
            if (!(await commitPresetSettings())) {
                await populatePresetSelect();
                return;
            }
            const presets = await loadPresets();
            const preset = createNewPreset(presets);
            presets.push(preset);
            activeSummaryPresetName = preset.name;
            applyPreset(preset);
            await savePresets(presets);
            await savePrompt();
            await saveSettings();
            await renderUI(true);
        }, "add-summary-preset", { settingsAction: true }));
        document.getElementById("hp-copy-current-preset")?.addEventListener("click", safeAsync(async () => {
            if (!(await commitPresetSettings())) {
                await populatePresetSelect();
                return;
            }
            const presets = await loadPresets();
            const index = presets.findIndex((preset) => preset.name === activeSummaryPresetName);
            if (index < 0) {
                alert("복사할 프리셋이 없습니다.");
                return;
            }
            const source = presets[index];
            const copy = {
                ...source,
                name: createCopiedPresetName(source.name, presets),
            };
            presets.push(copy);
            activeSummaryPresetName = copy.name;
            applyPreset(copy);
            await savePresets(presets);
            await savePrompt();
            await saveSettings();
            await renderUI(true);
        }, "copy-summary-preset", { settingsAction: true }));
        document.getElementById("hp-rename-current-preset")?.addEventListener("click", safeAsync(async () => {
            if (!(await commitPresetSettings())) {
                await populatePresetSelect();
                return;
            }
            const presets = await loadPresets();
            const index = presets.findIndex((p) => p.name === activeSummaryPresetName);
            if (index < 0) {
                alert("이름을 수정할 프리셋이 없습니다.");
                return;
            }
            const enteredName = await showTextInputDialog("프리셋 이름 수정", presets[index].name, "프리셋 이름");
            if (enteredName === null)
                return;
            const name = enteredName.trim();
            if (!name) {
                alert("프리셋 이름을 입력하세요.");
                return;
            }
            if (presets.some((p, i) => i !== index && p.name === name)) {
                alert(`프리셋 "${name}"이 이미 있습니다.`);
                return;
            }
            presets[index].name = name;
            activeSummaryPresetName = name;
            await savePresets(presets);
            await saveSettings();
            await renderUI(true);
        }, "rename-summary-preset", { settingsAction: true }));
        document.getElementById("hp-delete-current-preset")?.addEventListener("click", safeAsync(async () => {
            if (!(await commitPresetSettings())) {
                await populatePresetSelect();
                return;
            }
            const presets = await loadPresets();
            const index = presets.findIndex((p) => p.name === activeSummaryPresetName);
            if (index < 0) {
                alert("삭제할 프리셋이 없습니다.");
                return;
            }
            const ok = await showConfirmDialog(`프리셋 "${presets[index].name}"을 삭제할까요?`);
            if (!ok)
                return;
            presets.splice(index, 1);
            const nextPreset = presets[Math.min(index, presets.length - 1)] ?? null;
            activeSummaryPresetName = nextPreset?.name ?? "";
            if (nextPreset)
                applyPreset(nextPreset);
            await savePresets(presets);
            await savePrompt();
            await saveSettings();
            await renderUI(true);
        }, "delete-summary-preset", { settingsAction: true }));
        const importPresetBtn = document.getElementById("hp-import-preset");
        const importFileInput = document.getElementById("hp-import-file");
        importPresetBtn?.addEventListener("click", () => importFileInput?.click());
        importFileInput?.addEventListener("change", safeAsync(async () => {
            const file = importFileInput.files?.[0];
            if (!file)
                return;
            try {
                const preset = parseRisuPreset(await file.text());
                if (!preset) {
                    alert("올바른 하이파 프리셋 JSON이 아닙니다.");
                    return;
                }
                if (!(await commitPresetSettings()))
                    return;
                const presets = await loadPresets();
                const existingIndex = presets.findIndex((p) => p.name === preset.name);
                if (existingIndex >= 0)
                    presets[existingIndex] = preset;
                else
                    presets.push(preset);
                activeSummaryPresetName = preset.name;
                await savePresets(presets);
                applyPreset(preset);
                await savePrompt();
                await saveSettings();
                await renderUI(true);
            }
            finally {
                importFileInput.value = "";
            }
        }, "import-summary-preset", { settingsAction: true }));
        // ── Unified Regex Library handlers ─────────────────────────────────
        const regexDraft = getRegexSettingsDraft();
        const readRuleCard = (card) => {
            const id = card.dataset.regexRuleId;
            const rule = regexDraft.rules.find((r) => r.id === id);
            if (!rule)
                return;
            const checked = (q) => Boolean(card.querySelector(q)?.checked);
            rule.enabled = checked(".hp-regex-enabled");
            regexDraft.dirty = true;
            if (!card.querySelector(".hp-regex-editor"))
                return;
            rule.pattern = card.querySelector(".hp-regex-pattern")?.value ?? "";
            rule.replacement = card.querySelector(".hp-regex-replacement")?.value ?? "";
            rule.flags = normalizeJsRegexFlags(card.querySelector(".hp-regex-flags")?.value ?? "g");
            rule.enabled = checked(".hp-regex-enabled");
            rule.globalEnabled = checked(".hp-regex-global");
            rule.targets = { summarySource: checked(".hp-regex-target-summary"), chatQuery: checked(".hp-regex-target-query"), memoryEmbedding: checked(".hp-regex-target-memory") };
            const ids = new Set(regexDraft.ids ?? []);
            if (checked(".hp-regex-chat"))
                ids.add(rule.id);
            else
                ids.delete(rule.id);
            regexDraft.ids = [...ids];
        };
        document.querySelectorAll(".hp-regex-rule").forEach((card) => {
            card.addEventListener("input", () => readRuleCard(card));
            card.addEventListener("change", () => readRuleCard(card));
            card.querySelector(".hp-regex-open")?.addEventListener("click", async () => {
                const id = card.dataset.regexRuleId;
                if (!id)
                    return;
                if (expandedRegexRuleIds.has(id))
                    expandedRegexRuleIds.delete(id);
                else
                    expandedRegexRuleIds.add(id);
                await renderUI(true);
            });
            card.querySelector(".hp-regex-delete-rule")?.addEventListener("click", safeAsync(async () => {
                const id = card.dataset.regexRuleId;
                if (!id)
                    return;
                regexDraft.rules = regexDraft.rules.filter((r) => r.id !== id);
                expandedRegexRuleIds.delete(id);
                regexDraft.ids = (regexDraft.ids ?? []).filter((v) => v !== id);
                regexDraft.dirty = true;
                await renderUI(true);
            }, "delete-regex-rule", { settingsAction: true }));
        });
        document.getElementById("hp-regex-add-rule")?.addEventListener("click", safeAsync(async () => {
            const rule = createRegexRule();
            regexDraft.rules.push(rule);
            expandedRegexRuleIds.add(rule.id);
            regexDraft.dirty = true;
            await renderUI(true);
        }, "add-regex-rule", { settingsAction: true }));
        const regexFile = document.getElementById("hp-regex-import-file");
        document.getElementById("hp-regex-import-json")?.addEventListener("click", () => regexFile?.click());
        regexFile?.addEventListener("change", safeAsync(async () => {
            const file = regexFile.files?.[0];
            if (!file)
                return;
            const rules = parseRisuRegexFile(await file.text());
            regexFile.value = "";
            if (!rules) {
                alert("Risu 정규식 JSON을 읽지 못했습니다.");
                return;
            }
            if (!rules.length) {
                alert("가져올 editprocess 정규식이 없습니다.");
                return;
            }
            regexDraft.rules.push(...rules);
            regexDraft.dirty = true;
            await renderUI(true);
        }, "import-regex-json", { settingsAction: true }));
        document.getElementById("hp-regex-import-character")?.addEventListener("click", safeAsync(async () => {
            const rules = await fetchCurrentCharacterRegexRules();
            if (!rules.length) {
                alert("현재 캐릭터에서 가져올 editprocess 정규식을 찾지 못했습니다.");
                return;
            }
            regexDraft.rules.push(...rules);
            regexDraft.dirty = true;
            await renderUI(true);
        }, "import-character-regex", { settingsAction: true }));
    }
    function escapeHtml(text) {
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }
    // ── Initialization ───────────────────────────────────────────────────────
    await loadState();
    // Warm the verified o200k_base memory tokenizer path in parallel. The first
    // request/UI open awaits the same promise if initialization is still running.
    void ensureO200kMemoryTokenizer();
    // Automatic summarization and prompt-namespace injection routing both read the
    // current Risu database subset, so request the read-only DB permission up front.
    // Failure leaves Hypirk functional; namespace routing falls back to the empty profile.
    try {
        autoSummaryDbPermission = typeof risuai.requestPluginPermission === "function"
            ? await risuai.requestPluginPermission("db")
            : typeof risuai.getDatabase === "function";
    }
    catch (_) {
        autoSummaryDbPermission = false;
    }
    try {
        autoSummaryFetchLogsPermission = typeof risuai.requestPluginPermission === "function"
            ? await risuai.requestPluginPermission("fetchLogs")
            : typeof risuai.getFetchLogs === "function";
    }
    catch (_) {
        autoSummaryFetchLogsPermission = false;
    }
    try {
        if (typeof risuai.registerBodyIntercepter === "function") {
            await risuai.registerBodyIntercepter(autoSummaryBodyInterceptor);
        }
    }
    catch (error) {
        console.warn("[Hypirk] Main-request body interceptor unavailable; automatic summary will use content matching only.", error);
    }
    // Keep only unsummarized messages in the live context while Hypirk owns the
    // automatic-memory runtime. When Risu/HypaV3 memory is toggled ON, this process
    // hook becomes transparent: automatic summarization and raw-chat pruning are
    // both suspended, while manual summaries and Hypirk's management UI remain usable.
    // When no chunks exist, all messages pass through unchanged.
    // When chunks exist, only messages with chat_index > lastSummarizedMsgIndex are kept.
    // The first message (chat_index -1) is handled via msgIndex -1 in chunks.
    await risuai.addRisuScriptHandler("process", async (text) => {
        // Auxiliary summary calls may re-enter plugin hooks; never wait on our own lease.
        if (isSummarizing) return text;
        await refreshChatContextForRequestBurst();
        return withChatOperation(async () => {
        const risuMemoryToggleEnabled = isRisuMemoryToggleEnabled();
        if (risuMemoryToggleEnabled) {
            return text;
        }
        if (!isSummarizing) {
            // Provider usage belongs to the previous completed main request. Running
            // automatic summarization here ensures the boundary is updated BEFORE
            // this process template decides which chat messages Risu will keep.
            await reconcileAutoSummaryUsage("next-process");
            await runPendingAutomaticSummary();
        }
        const lastIdx = getLastSummarizedMsgIndex();
        const filtered = lastIdx >= 0;
        // No chunks yet — keep everything
        if (!filtered)
            return text;
        // Chunks exist — filter out already-summarized messages
        const firstPendingIdx = lastIdx + 1;
        return `{{#if {{greater_equal::{{chat_index}}::${firstPendingIdx}}}}}\n${text}\n{{/if}}`;
        });
    });
    // Register replacers for message tracking and memory injection
    await risuai.addRisuReplacer("beforeRequest", beforeRequestHandler);
    await risuai.addRisuReplacer("afterRequest", afterRequestHandler);
    // Register settings UI
    await risuai.registerSetting("하피크", openSettings, HYPIRK_ICON_SVG, "html", "hypirk-settings");
    // Register a quick action button to open the Hypirk GUI
    await risuai.registerButton({
        name: "하피크",
        icon: HYPIRK_ICON_SVG,
        iconType: "html",
        location: "chat",
        id: "hypirk-gui",
    }, async () => {
        await openSettings();
    });
})();

