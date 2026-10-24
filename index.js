/**
 * ════════════════════════════════════════════════════════════════════
 * Inline Image Generation + Wardrobe
 * Based on: notsosillynotsoimages by aceeenvw
 *           + wardrobe system from sillyimages
 *
 * Module 1 — SillyWardrobe IIFE  (outfit data, modal UI, public API)
 * Module 2 — Inline Image Gen    (generation engine + wardrobe refs)
 * ════════════════════════════════════════════════════════════════════
 */

/* ╔═══════════════════════════════════════════════════════════════╗
   ║  MODULE 1 — SillyWardrobe                                    ║
   ╚═══════════════════════════════════════════════════════════════╝ */

(function initWardrobe() {
    'use strict';

    const SW_MODULE = 'silly_wardrobe';

    /* ── helpers ── */

    function uid() {
        return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
    }

    function swLog(level, ...args) {
        const fn = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
        fn('[SW]', ...args);
    }

    function sanitize(text) {
        const d = document.createElement('div');
        d.textContent = text || '';
        return d.innerHTML;
    }

    /* ── settings ── */

    const defaultSettings = Object.freeze({
        wardrobes: {},
        activeOutfits: {},
        maxDimension: 512,
        // Vision настройки для анализа аутфитов — ОТДЕЛЬНО от image-gen модели
        // Нужна vision-capable модель (gpt-4o, gemini-2.0-flash, claude-3-5-sonnet и т.д.)
        visionEndpoint: '',
        visionApiKey: '',
        visionModel: '',
        // ── Общий (глобальный) гардероб — единая коллекция на ВСЕХ персонажей ──
        // Картинки храним ФАЙЛАМИ (imagePath), а не base64, чтобы не раздувать settings.json.
        // *Active — глобальный фолбэк (нет открытого чата); *ActiveByChat — что надето в каждом чате: { [chatId]: outfitId }.
        sharedUserWardrobe: [], sharedUserActive: null, sharedUserActiveByChat: {}, useSharedUserWardrobe: false,
        sharedBotWardrobe:  [], sharedBotActive:  null, sharedBotActiveByChat:  {}, useSharedBotWardrobe:  false,
    });

    function getSettings() {
        const ctx = SillyTavern.getContext();
        if (!ctx.extensionSettings[SW_MODULE]) {
            ctx.extensionSettings[SW_MODULE] = structuredClone(defaultSettings);
        }
        const s = ctx.extensionSettings[SW_MODULE];
        // structuredClone, чтобы не присвоить общую ссылку на замороженный дефолтный объект/массив.
        for (const k of Object.keys(defaultSettings)) {
            if (!Object.hasOwn(s, k)) s[k] = structuredClone(defaultSettings[k]);
        }
        // Защита от повреждённых настроек.
        if (!Array.isArray(s.sharedUserWardrobe)) s.sharedUserWardrobe = [];
        if (!Array.isArray(s.sharedBotWardrobe)) s.sharedBotWardrobe = [];
        if (!s.sharedUserActiveByChat || typeof s.sharedUserActiveByChat !== 'object') s.sharedUserActiveByChat = {};
        if (!s.sharedBotActiveByChat || typeof s.sharedBotActiveByChat !== 'object') s.sharedBotActiveByChat = {};
        // ── Типы одежды: засев из дефолтов при первом запуске ──
        if (!Array.isArray(s.outfitTypes) || !s.outfitTypes.length) {
            s.outfitTypes = structuredClone(SW_DEFAULT_TYPES);
        }
        // Чистка повреждённых записей + гарантия запасного тега «Другое».
        if (s.outfitTypes.some(t => !t || typeof t.id !== 'string' || !t.id)) {
            s.outfitTypes = s.outfitTypes.filter(t => t && typeof t.id === 'string' && t.id);
        }
        if (!s.outfitTypes.some(t => t.id === SW_FALLBACK_TYPE)) s.outfitTypes.push({ id: SW_FALLBACK_TYPE, label: 'Другое', icon: 'fa-tag' });
        return s;
    }

    function saveSettings() {
        SillyTavern.getContext().saveSettingsDebounced();
    }

    /* ── context ── */

    function getCharName() {
        const ctx = SillyTavern.getContext();
        if (ctx.characterId !== undefined && ctx.characters?.[ctx.characterId]) {
            return ctx.characters[ctx.characterId].name || '';
        }
        return '';
    }

    /* ── wardrobe data ── */

    function getWardrobe(charName) {
        const s = getSettings();
        if (!s.wardrobes[charName]) s.wardrobes[charName] = { bot: [], user: [] };
        return s.wardrobes[charName];
    }

    function getActiveIds() {
        const charName = getCharName();
        if (!charName) return { bot: null, user: null };
        const s = getSettings();
        if (!s.activeOutfits[charName]) s.activeOutfits[charName] = { bot: null, user: null };
        return s.activeOutfits[charName];
    }

    function setActiveId(type, outfitId) {
        const charName = getCharName();
        if (!charName) { toastr.error('Персонаж не выбран', 'Гардероб'); return false; }
        const s = getSettings();
        if (!s.activeOutfits[charName]) s.activeOutfits[charName] = { bot: null, user: null };
        s.activeOutfits[charName][type] = outfitId;
        saveSettings();
        return true;
    }

    function addOutfit(charName, type, outfit) {
        getWardrobe(charName)[type].push(outfit);
        saveSettings();
    }

    function removeOutfit(charName, type, outfitId) {
        const w = getWardrobe(charName);
        w[type] = w[type].filter(o => o.id !== outfitId);
        if (getActiveIds()[type] === outfitId) setActiveId(type, null);
        saveSettings();
        swUpdatePromptInjection();
    }

    function findOutfit(charName, type, id) {
        return getWardrobe(charName)[type].find(o => o.id === id) || null;
    }

    /* ══════════════════════════════════════════════════════════════
       Общий гардероб (shared) + типы одежды + чистка файлов
       Портировано из обновлённого sillyimages, адаптировано под vish.
    ══════════════════════════════════════════════════════════════ */

    // ── Типы одежды (категории) — теперь редактируемые пользователем ──
    // Дефолтный набор — «семя» при первом запуске. Дальше список редактируется
    // менеджером тегов (в настройках) и хранится в settings.outfitTypes.
    const SW_DEFAULT_TYPES = [
        { id: 'casual',    label: 'Повседневное',   icon: 'fa-shirt' },
        { id: 'formal',    label: 'Формальное',     icon: 'fa-gem' },
        { id: 'sport',     label: 'Спортивное',     icon: 'fa-person-running' },
        { id: 'sleep',     label: 'Спальное',       icon: 'fa-bed' },
        { id: 'beach',     label: 'Пляж/купальник', icon: 'fa-umbrella-beach' },
        { id: 'work',      label: 'Работа',         icon: 'fa-briefcase' },
        { id: 'underwear', label: 'Бельё',          icon: 'fa-heart' },
        { id: 'outer',     label: 'Верхняя',        icon: 'fa-mitten' },
        { id: 'other',     label: 'Другое',         icon: 'fa-tag' },
    ];
    // Запасной тег: всегда существует, удалить нельзя — сюда уходят наряды удалённых тегов.
    const SW_FALLBACK_TYPE = 'other';
    // Палитра иконок для выбора при создании/редактировании тега.
    const SW_TYPE_ICONS = [
        'fa-shirt', 'fa-gem', 'fa-person-running', 'fa-bed', 'fa-umbrella-beach',
        'fa-briefcase', 'fa-mitten', 'fa-tag', 'fa-crown', 'fa-hat-cowboy',
        'fa-vest', 'fa-socks', 'fa-shoe-prints', 'fa-glasses', 'fa-ring',
        'fa-user-tie', 'fa-user-ninja', 'fa-mask', 'fa-snowflake', 'fa-sun',
        'fa-heart', 'fa-star', 'fa-wand-magic-sparkles', 'fa-dragon',
    ];

    // Эффективный список типов из настроек (гарантированно с запасным тегом).
    function swTypes() { return getSettings().outfitTypes; }
    function swTypeIds() { return swTypes().map(t => t.id); }
    function swTypeOf(o) { return (o && swTypeIds().includes(o.type)) ? o.type : SW_FALLBACK_TYPE; }
    function swTypeMeta(id) { const ts = swTypes(); return ts.find(t => t.id === id) || ts.find(t => t.id === SW_FALLBACK_TYPE) || ts[ts.length - 1]; }

    // Обойти все наряды во всех гардеробах (персональные + общие).
    function swForEachOutfit(s, cb) {
        const arrays = [s.sharedBotWardrobe, s.sharedUserWardrobe];
        for (const w of Object.values(s.wardrobes || {})) if (w) arrays.push(w.bot, w.user);
        for (const arr of arrays) if (Array.isArray(arr)) for (const o of arr) if (o) cb(o);
    }
    function swMigrateTypeId(s, oldId, newId) { swForEachOutfit(s, (o) => { if (o.type === oldId) o.type = newId; }); }

    // ── CRUD тегов (менеджер тегов в настройках) ──
    function swAddType() {
        const s = getSettings();
        let n = 1, id; do { id = 'tag' + (n++); } while (s.outfitTypes.some(t => t.id === id));
        const t = { id, label: 'Новый тег', icon: 'fa-tag' };
        const fi = s.outfitTypes.findIndex(x => x.id === SW_FALLBACK_TYPE); // «Другое» держим последним
        if (fi >= 0) s.outfitTypes.splice(fi, 0, t); else s.outfitTypes.push(t);
        saveSettings();
        return t;
    }
    // Тег из каталога: если такого id у пользователя нет — добавляется с подписью и иконкой каталога.
    function swEnsureType(cat) {
        if (!cat?.id) return SW_FALLBACK_TYPE;
        const s = getSettings();
        if (s.outfitTypes.some(x => x.id === cat.id)) return cat.id;
        const t = { id: cat.id, label: cat.label || cat.id, icon: cat.icon || 'fa-tag' };
        const fi = s.outfitTypes.findIndex(x => x.id === SW_FALLBACK_TYPE); // «Другое» держим последним
        if (fi >= 0) s.outfitTypes.splice(fi, 0, t); else s.outfitTypes.push(t);
        saveSettings();
        return t.id;
    }
    function swRenameType(id, label) { const t = swTypes().find(x => x.id === id); if (t) { t.label = label; saveSettings(); } }
    function swSetTypeIcon(id, icon) { const t = swTypes().find(x => x.id === id); if (t) { t.icon = icon; saveSettings(); } }
    function swDeleteType(id) {
        if (id === SW_FALLBACK_TYPE) return 0;
        const s = getSettings();
        let moved = 0;
        swForEachOutfit(s, (o) => { if (o.type === id) { o.type = SW_FALLBACK_TYPE; moved++; } });
        s.outfitTypes = s.outfitTypes.filter(x => x.id !== id);
        saveSettings();
        return moved;
    }

    // Источник картинки для <img>: файл (общий гардероб) или inline base64 (per-char, JPEG).
    function swImgSrc(o) {
        if (!o) return '';
        if (o.imagePath) return o.imagePath;
        if (o.base64) return 'data:image/jpeg;base64,' + o.base64;
        return '';
    }

    // Кэш base64 активного образа общего гардероба ПО СТОРОНЕ — ленивая загрузка из файла.
    // В памяти держим только активный образ каждой стороны, не весь гардероб.
    const swSharedCache = { bot: { b64: null, id: null }, user: { b64: null, id: null } };

    function swCurrentChatId() {
        try {
            const ctx = SillyTavern.getContext();
            return (typeof ctx.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : null) || null;
        } catch (e) { return null; }
    }

    // ── Конфиг общего гардероба ПО СТОРОНЕ ('bot' | 'user') ──
    function swSharedCfg(side) {
        const s = getSettings();
        const k = side === 'bot'
            ? { list: 'sharedBotWardrobe',  active: 'sharedBotActive',  byChat: 'sharedBotActiveByChat',  use: 'useSharedBotWardrobe' }
            : { list: 'sharedUserWardrobe', active: 'sharedUserActive', byChat: 'sharedUserActiveByChat', use: 'useSharedUserWardrobe' };
        return {
            use: () => !!s[k.use],
            setUse: (v) => { s[k.use] = !!v; },
            list: () => s[k.list],
            setList: (arr) => { s[k.list] = arr; },
            global: () => s[k.active] || null,
            setGlobal: (id) => { s[k.active] = id; },
            byChat: () => s[k.byChat],
            fileLabel: () => (side === 'bot' ? 'sw_bot_' : 'sw_user_'),
        };
    }

    function swGetSharedActiveId(side) {
        const cfg = swSharedCfg(side);
        const cid = swCurrentChatId();
        if (cid) { const m = cfg.byChat(); return Object.hasOwn(m, cid) ? m[cid] : null; }
        return cfg.global(); // нет открытого чата → глобальный фолбэк
    }
    function swSetSharedActiveId(side, id) {
        const cfg = swSharedCfg(side);
        const cid = swCurrentChatId();
        if (cid) { const m = cfg.byChat(); if (id == null) delete m[cid]; else m[cid] = id; }
        else cfg.setGlobal(id);
        saveSettings();
    }

    // Активный образ стороны с учётом режима (Общий / Персональный).
    function swGetActiveSideOutfit(side) {
        const cfg = swSharedCfg(side);
        if (cfg.use()) {
            const id = swGetSharedActiveId(side);
            return id ? (cfg.list().find(o => o.id === id) || null) : null;
        }
        const cn = getCharName(); if (!cn) return null;
        const a = getActiveIds(); return a[side] ? findOutfit(cn, side, a[side]) : null;
    }

    // Ленивая предзагрузка base64 активного образа общего гардероба (по стороне).
    async function swPreloadSharedActive(side) {
        try {
            const cfg = swSharedCfg(side);
            const c = swSharedCache[side];
            const id = cfg.use() ? swGetSharedActiveId(side) : null;
            if (!id) { c.b64 = null; c.id = null; return; }
            if (c.id === id && c.b64) return; // уже в кэше
            const o = cfg.list().find(x => x.id === id);
            if (!o) { c.b64 = null; c.id = null; return; }
            let b64 = o.base64 || null; // fallback, если файл не сохранился
            if (!b64 && o.imagePath && typeof loadRefImageAsBase64 === 'function') b64 = await loadRefImageAsBase64(o.imagePath);
            c.b64 = b64; c.id = b64 ? id : null;
        } catch (e) {
            swLog('WARN', `preload shared active (${side}) failed:`, e.message);
            const c = swSharedCache[side]; c.b64 = null; c.id = null;
        }
    }
    function swPreloadAllShared() { swPreloadSharedActive('bot'); swPreloadSharedActive('user'); }

    // Единая абстракция «вид гардероба» по стороне: общий (файловый) ИЛИ per-character.
    function swViewForSide(side) {
        const cfg = swSharedCfg(side);
        if (cfg.use()) {
            return {
                shared: true, side,
                list: () => cfg.list(),
                activeId: () => swGetSharedActiveId(side),       // что надето в ЭТОМ чате
                setActive: (id) => { swSetSharedActiveId(side, id); return true; },
                find: (id) => cfg.list().find(o => o.id === id) || null,
                add: (o) => { cfg.list().push(o); saveSettings(); },
                remove: (id) => {
                    const gone = cfg.list().find(o => o.id === id); // запомним путь к файлу ДО удаления
                    cfg.setList(cfg.list().filter(o => o.id !== id));
                    if (cfg.global() === id) cfg.setGlobal(null);
                    // снять удалённый образ во всех чатах, где он был надет
                    const m = cfg.byChat(); for (const key of Object.keys(m)) if (m[key] === id) delete m[key];
                    saveSettings();
                    // Общий гардероб удаляем «с концами» — стираем и сам файл с сервера
                    // (только если на него больше ничего не ссылается).
                    if (gone?.imagePath) swMaybeDeleteOutfitFile(gone.imagePath);
                },
            };
        }
        const cn = getCharName();
        return {
            shared: false, side,
            list: () => cn ? getWardrobe(cn)[side] : [],
            activeId: () => getActiveIds()[side],
            setActive: (id) => setActiveId(side, id),
            find: (id) => cn ? findOutfit(cn, side, id) : null,
            add: (o) => { if (cn) addOutfit(cn, side, o); },
            remove: (id) => { if (cn) removeOutfit(cn, side, id); },
        };
    }

    // ── Миграция: перенос старых per-character нарядов в ОБЩИЙ гардероб (по стороне) ──
    // Создаёт КОПИИ (как файлы), оригиналы НЕ трогает. Идемпотентно (по srcId).
    function swSharedHasSrc(side, srcId) { return swSharedCfg(side).list().some(x => x.srcId === srcId); }
    function swCollectPendingOutfits(side) {
        const s = getSettings();
        const out = [];
        for (const w of Object.values(s.wardrobes || {})) {
            if (!w || !Array.isArray(w[side])) continue;
            for (const o of w[side]) if ((o.base64 || o.imagePath) && !swSharedHasSrc(side, o.id)) out.push(o);
        }
        return out;
    }
    function swCountPendingMigration(side) { return swCollectPendingOutfits(side).length; }

    // Авто-надеть в общем гардеробе копию того, что было одето у ТЕКУЩЕГО персонажа (по стороне).
    function swAutoWearSharedFromCurrent(side, { force = false } = {}) {
        const s = getSettings();
        const cn = getCharName(); if (!cn) return null;
        const wornId = s.activeOutfits?.[cn]?.[side];
        if (!wornId) return null;                              // ничего не было одето
        if (!force && swGetSharedActiveId(side)) return null;  // не клоберим уже выбранный в этом чате
        const copy = swSharedCfg(side).list().find(x => x.srcId === wornId);
        if (!copy) return null;
        swSetSharedActiveId(side, copy.id);
        swPreloadSharedActive(side);
        return copy.name || 'образ';
    }

    async function swMigrateToShared(side) {
        const cfg = swSharedCfg(side);
        const pending = swCollectPendingOutfits(side);
        if (!pending.length) { toastr.info('Все старые наряды уже в общем гардеробе', 'Гардероб'); return 0; }
        toastr.info(`Импорт ${pending.length} нарядов… разовая операция`, 'Гардероб', { timeOut: 4000 });
        let done = 0, failed = 0;
        // Последовательно — чтобы не нагружать сервер залпом загрузок.
        for (const o of pending) {
            try {
                const item = { id: uid(), srcId: o.id, name: o.name || 'Без имени', description: o.description || '', type: swTypeOf(o), addedAt: o.addedAt || Date.now() };
                let stored = false;
                if (o.imagePath && !o.base64) {
                    item.imagePath = o.imagePath; stored = true; // уже файл — просто ссылаемся
                } else if (o.base64 && typeof compressBase64Image === 'function' && typeof saveRefImageToFile === 'function') {
                    try {
                        const jpeg = await compressBase64Image(o.base64, getSettings().maxDimension, 0.82);
                        item.imagePath = await saveRefImageToFile(jpeg, cfg.fileLabel() + (o.name || 'item'));
                        stored = true;
                    } catch (err) { swLog('WARN', 'migrate file store failed, fallback base64:', err.message); }
                }
                if (!stored) item.base64 = o.base64 || '';
                cfg.list().push(item);
                done++;
                if (done % 5 === 0) saveSettings(); // периодически сохраняем прогресс
            } catch (e) { failed++; swLog('WARN', 'migrate item failed:', e.message); }
        }
        saveSettings();
        // Если у текущего персонажа что-то было одето — автоматически надеваем перенесённую копию.
        const worn = swAutoWearSharedFromCurrent(side, { force: true });
        swPreloadSharedActive(side);
        toastr.success(`Импортировано: ${done}${failed ? `, не удалось: ${failed}` : ''}.${worn ? ` Надет: «${worn}».` : ''} Оригиналы на месте.`, 'Гардероб', { timeOut: 5000 });
        return done;
    }

    // ── Чистка неиспользуемых файлов в папке iig_refs ──
    function swCollectReferencedFiles() {
        const ctx = SillyTavern.getContext();
        const referenced = new Set();
        let dir = '/user/images/iig_refs/';
        const addRef = (p) => {
            if (!p || typeof p !== 'string') return;
            const i = p.lastIndexOf('/');
            const base = i >= 0 ? p.slice(i + 1) : p;
            if (base) referenced.add(base);
            if (i > 0 && p.includes('iig_refs')) dir = p.slice(0, i + 1);
        };
        const sw = ctx.extensionSettings?.silly_wardrobe;
        if (sw) {
            for (const o of (sw.sharedUserWardrobe || [])) addRef(o.imagePath);
            for (const o of (sw.sharedBotWardrobe || [])) addRef(o.imagePath);
            for (const w of Object.values(sw.wardrobes || {})) {
                if (!w) continue;
                for (const side of ['bot', 'user']) for (const o of (w[side] || [])) addRef(o.imagePath);
            }
        }
        // Настройки генерации: текущие (vish_image_gen) и старые (inline_image_gen),
        // чтобы чистка не удалила файлы, на которые ссылается любая из копий.
        for (const key of ['vish_image_gen', 'inline_image_gen']) {
            const iig = ctx.extensionSettings?.[key];
            if (!iig) continue;
            addRef(iig.charRef?.imagePath);
            addRef(iig.userRef?.imagePath);
            for (const n of (iig.npcReferences || [])) { addRef(n?.imagePath); addRef(n?.outfit?.imagePath); }
            for (const st of (Array.isArray(iig.styles) ? iig.styles : [])) addRef(st?.imagePath);
        }
        return { referenced, dir };
    }
    async function swScanOrphans() {
        const ctx = SillyTavern.getContext();
        const { referenced, dir } = swCollectReferencedFiles();
        const resp = await fetch('/api/images/list', {
            method: 'POST',
            headers: ctx.getRequestHeaders ? ctx.getRequestHeaders() : { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folder: 'iig_refs', sortField: 'date', sortOrder: 'desc' }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const files = await resp.json();
        const list = Array.isArray(files) ? files.filter(f => typeof f === 'string') : [];
        const orphans = list.filter(f => !referenced.has(f));
        return { orphans, totalFiles: list.length, referencedCount: referenced.size, dir };
    }
    async function swDeleteFiles(dir, filenames) {
        const ctx = SillyTavern.getContext();
        let ok = 0, fail = 0;
        for (const f of filenames) {
            try {
                const r = await fetch('/api/images/delete', {
                    method: 'POST',
                    headers: ctx.getRequestHeaders ? ctx.getRequestHeaders() : { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: dir + f }),
                });
                if (r.ok) ok++; else fail++;
            } catch (e) { fail++; swLog('WARN', 'delete file failed:', f, e.message); }
        }
        return { ok, fail };
    }

    // Удалить файл картинки образа с сервера — но только если на него больше НИЧЕГО не ссылается
    // (другой наряд, НПС или референс). Безопасно: не бросает исключений, файл уже снят из настроек.
    async function swMaybeDeleteOutfitFile(imagePath) {
        try {
            if (!imagePath || typeof imagePath !== 'string') return;
            const i = imagePath.lastIndexOf('/');
            const base = i >= 0 ? imagePath.slice(i + 1) : imagePath;
            const dir = i >= 0 ? imagePath.slice(0, i + 1) : '/user/images/iig_refs/';
            const { referenced } = swCollectReferencedFiles();
            if (referenced.has(base)) return; // ещё используется где-то — файл не трогаем
            await swDeleteFiles(dir, [base]);
            swLog('INFO', 'shared outfit file removed from disk:', base);
        } catch (e) { swLog('WARN', 'swMaybeDeleteOutfitFile failed:', e.message); }
    }

    /* ── image processing ── */

    function resizeImage(file, maxDim) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    let { width, height } = img;
                    if (width > maxDim || height > maxDim) {
                        const r = Math.min(maxDim / width, maxDim / height);
                        width = Math.round(width * r);
                        height = Math.round(height * r);
                    }
                    const c = document.createElement('canvas');
                    c.width = width; c.height = height;
                    c.getContext('2d').drawImage(img, 0, 0, width, height);
                    resolve({ base64: c.toDataURL('image/jpeg', 0.85).split(',')[1] });
                };
                img.onerror = () => reject(new Error('Image decode failed'));
                img.src = e.target.result;
            };
            reader.onerror = () => reject(new Error('File read failed'));
            reader.readAsDataURL(file);
        });
    }

    /* ── modal ── */

    let modalOpen = false;
    let currentTab = 'bot';

    function openModal() {
        closeModal();
        modalOpen = true;
        const charName = getCharName();
        if (!charName) {
            toastr.warning('Сначала выберите персонажа', 'Гардероб');
            modalOpen = false;
            return;
        }

        const overlay = document.createElement('div');
        overlay.id = 'sw-modal-overlay';
        overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });

        const modal = document.createElement('div');
        modal.id = 'sw-modal';
        modal.innerHTML = `
            <div class="sw-modal-header">
                <div class="sw-modal-title">
                    <i class="fa-solid fa-shirt" style="margin-right:8px;opacity:0.7"></i>
                    Гардероб — <b style="margin-left:4px">${sanitize(charName)}</b>
                </div>
                <div class="sw-modal-close interactable" title="Закрыть">
                    <i class="fa-solid fa-xmark"></i>
                </div>
            </div>
            <div class="sw-tabs">
                <div class="sw-tab interactable ${currentTab === 'bot' ? 'sw-tab-active' : ''}" data-tab="bot">
                    <i class="fa-solid fa-robot"></i> Бот
                </div>
                <div class="sw-tab interactable ${currentTab === 'user' ? 'sw-tab-active' : ''}" data-tab="user">
                    <i class="fa-solid fa-user"></i> Юзер
                </div>
            </div>
            <div class="sw-active-info" id="sw-active-info"></div>
            <div class="sw-tab-content" id="sw-tab-content"></div>
        `;

        overlay.appendChild(modal);

        // ── Fix: bypass CSS transform ancestors that break position:fixed ──
        // Appending to <html> (not body) and forcing position via JS ensures
        // the overlay always covers the full viewport on mobile ST builds.
        let _overlayResizeObserver = null;
        function _fixOverlayPos() {
            overlay.style.position = 'fixed';
            overlay.style.top    = '0px';
            overlay.style.left   = '0px';
            overlay.style.width  = window.innerWidth  + 'px';
            overlay.style.height = window.innerHeight + 'px';
        }
        _fixOverlayPos();
        _overlayResizeObserver = new ResizeObserver(_fixOverlayPos);
        _overlayResizeObserver.observe(document.documentElement);

        // Store observer so closeModal can kill it
        overlay._resizeObserver = _overlayResizeObserver;

        document.documentElement.appendChild(overlay);

        modal.querySelector('.sw-modal-close').addEventListener('click', closeModal);
        for (const tab of modal.querySelectorAll('.sw-tab')) {
            tab.addEventListener('click', () => {
                currentTab = tab.dataset.tab;
                modal.querySelectorAll('.sw-tab').forEach(t =>
                    t.classList.toggle('sw-tab-active', t.dataset.tab === currentTab));
                renderTabContent();
            });
        }

        // ── Swipe-down to close (mobile bottom sheet) ──────────────
        let touchStartY = 0, touchDeltaY = 0, isSwiping = false;

        modal.addEventListener('touchstart', (e) => {
            const header = modal.querySelector('.sw-modal-header');
            if (!header?.contains(e.target) && e.target !== modal) return;
            touchStartY = e.touches[0].clientY;
            touchDeltaY = 0;
            isSwiping = true;
        }, { passive: true });

        modal.addEventListener('touchmove', (e) => {
            if (!isSwiping) return;
            touchDeltaY = e.touches[0].clientY - touchStartY;
            if (touchDeltaY > 0) {
                modal.style.transform = `translateY(${Math.sqrt(touchDeltaY) * 6}px)`;
                modal.style.transition = 'none';
            }
        }, { passive: true });

        modal.addEventListener('touchend', () => {
            if (!isSwiping) return;
            isSwiping = false;
            modal.style.transform = '';
            modal.style.transition = '';
            if (touchDeltaY > 80) {
                modal.style.transition = 'transform 0.25s ease';
                modal.style.transform = 'translateY(110%)';
                overlay.style.transition = 'opacity 0.25s ease';
                overlay.style.opacity = '0';
                setTimeout(closeModal, 240);
            }
        }, { passive: true });

        renderTabContent();
        document.addEventListener('keydown', onEsc);
    }

    function onEsc(e) { if (e.key === 'Escape') closeModal(); }

    function closeModal() {
        modalOpen = false;
        const existing = document.getElementById('sw-modal-overlay');
        existing?._resizeObserver?.disconnect();
        existing?.remove();
        document.removeEventListener('keydown', onEsc);
        // Refresh the inline wardrobe preview in settings
        refreshWardrobeSettingsDisplay();
    }

    /* ── tab rendering ── */

    function renderTabContent() {
        const container = document.getElementById('sw-tab-content');
        const infoBar = document.getElementById('sw-active-info');
        if (!container) return;

        const charName = getCharName();
        const outfits = getWardrobe(charName)[currentTab] || [];
        const activeId = getActiveIds()[currentTab];

        if (infoBar) {
            const activeOutfit = activeId ? findOutfit(charName, currentTab, activeId) : null;
            if (activeOutfit) {
                infoBar.innerHTML = `<i class="fa-solid fa-check" style="color:#6ee7b7;margin-right:6px"></i>Активно: <b style="margin-left:4px">${sanitize(activeOutfit.name)}</b>${activeOutfit.description ? ` — <i>${sanitize(activeOutfit.description)}</i>` : ''}`;
                infoBar.classList.add('sw-active-visible');
            } else {
                infoBar.innerHTML = '<i class="fa-solid fa-circle-minus" style="margin-right:6px;opacity:0.4"></i>Ничего не надето';
                infoBar.classList.remove('sw-active-visible');
            }
        }

        let html = '<div class="sw-outfit-grid">';
        html += `<div class="sw-outfit-card sw-upload-card interactable" id="sw-upload-trigger">
            <div class="sw-upload-icon"><i class="fa-solid fa-plus"></i></div><span>Загрузить</span>
        </div>`;

        for (const o of outfits) {
            const isActive = o.id === activeId;
            html += `
                <div class="sw-outfit-card ${isActive ? 'sw-outfit-active' : ''}" data-id="${o.id}">
                    <div class="sw-outfit-img-wrap">
                        <img src="data:image/jpeg;base64,${o.base64}" alt="${sanitize(o.name)}" class="sw-outfit-img" loading="lazy">
                        ${isActive ? '<div class="sw-active-badge"><i class="fa-solid fa-check"></i></div>' : ''}
                    </div>
                    <div class="sw-outfit-footer">
                        <span class="sw-outfit-name" title="${sanitize(o.description || o.name)}">${sanitize(o.name)}</span>
                        <div class="sw-outfit-btns">
                            <div class="sw-btn-activate" title="${isActive ? 'Снять' : 'Надеть'}"><i class="fa-solid ${isActive ? 'fa-toggle-on' : 'fa-toggle-off'}"></i></div>
                            <div class="sw-btn-edit" title="Редактировать"><i class="fa-solid fa-pen"></i></div>
                            <div class="sw-btn-delete" title="Удалить"><i class="fa-solid fa-trash-can"></i></div>
                        </div>
                    </div>
                </div>`;
        }

        html += '</div>';
        container.innerHTML = html;

        document.getElementById('sw-upload-trigger')?.addEventListener('click', handleUpload);

        for (const card of container.querySelectorAll('.sw-outfit-card[data-id]')) {
            const id = card.dataset.id;
            card.querySelector('.sw-outfit-img')?.addEventListener('click', (e) => {
                e.preventDefault(); e.stopPropagation();
                toggleActive(id);
            });
            card.querySelector('.sw-btn-activate')?.addEventListener('click', (e) => {
                e.preventDefault(); e.stopPropagation();
                toggleActive(id);
            });
            card.querySelector('.sw-btn-edit')?.addEventListener('click', (e) => {
                e.preventDefault(); e.stopPropagation();
                handleEdit(charName, currentTab, id);
            });
            card.querySelector('.sw-btn-delete')?.addEventListener('click', (e) => {
                e.preventDefault(); e.stopPropagation();
                if (confirm('Удалить этот аутфит?')) {
                    removeOutfit(charName, currentTab, id);
                    renderTabContent();
                    toastr.info('Аутфит удалён', 'Гардероб');
                }
            });
        }
    }

    function toggleActive(id) {
        try {
            const a = getActiveIds();
            const isDeactivating = a[currentTab] === id;
            const charName = getCharName();
            const outfit = findOutfit(charName, currentTab, id);
            const outfitName = outfit?.name || id;
            const ok = setActiveId(currentTab, isDeactivating ? null : id);
            if (ok === false) return;
            renderTabContent();
            swUpdatePromptInjection();
            // Sync sendbar panel if open
            if (typeof window._vwSyncFromSettings === 'function') window._vwSyncFromSettings();
            if (isDeactivating) {
                toastr.info(`«${outfitName}» снят`, 'Гардероб', { timeOut: 2000 });
            } else {
                toastr.success(`«${outfitName}» надет`, 'Гардероб', { timeOut: 2000 });
            }
        } catch (err) {
            toastr.error('Ошибка: ' + err.message, 'Гардероб');
        }
    }

    /**
     * Очищает ответ ИИ от RP-мусора: <think>, OOC-маркеров, системных инжектов и т.д.
     * Возвращает чистое описание одежды или null если ничего не осталось.
     */
    function swCleanOutfitDesc(raw) {
        if (!raw) return null;
        let s = raw;
        // Убираем <think>...</think> целиком
        s = s.replace(/<think>[\s\S]*?<\/think>/gi, '');
        // Убираем HTML-теги
        s = s.replace(/<[^>]+>/g, '');
        // Убираем HTML-комментарии <!-- -->
        s = s.replace(/<!--[\s\S]*?-->/g, '');
        // Убираем системные маркеры расширения
        s = s.replace(/\[OOC:[^\]]*\]/gi, '');
        s = s.replace(/\[[^\]]*_SCORE[^\]]*\]/gi, '');
        s = s.replace(/\[CYCLE_DAY[^\]]*\]/gi, '');
        s = s.replace(/\[LOVE_SCORE[^\]]*\]/gi, '');
        // Убираем строки содержащие системный мусор
        s = s.split('\n').filter(line => {
            const l = line.toLowerCase();
            return !l.includes('scene_desc') &&
                   !l.includes('atmosphere') &&
                   !l.includes('location:') &&
                   !l.includes('characters:') &&
                   !l.includes('costume:') &&
                   !l.includes('event:') &&
                   !l.includes('bgm>') &&
                   !l.includes('horae') &&
                   !l.includes('[cycle_') &&
                   !l.match(/^\s*\*/);  // строки начинающиеся со * (RP-действия)
        }).join(' ');
        // Убираем *курсив* и _подчёркивание_ RP-форматирования
        s = s.replace(/\*[^*]+\*/g, '').replace(/_[^_]+_/g, '');
        // Схлопываем пробелы
        s = s.replace(/\s+/g, ' ').trim();
        // Берём только первые 2 предложения
        const sentences = s.match(/[^.!?]+[.!?]+/g);
        if (sentences && sentences.length > 2) s = sentences.slice(0, 2).join(' ').trim();
        return s.length >= 15 ? s : null;
    }

    /**
     * Анализирует изображение аутфита через ИЗОЛИРОВАННЫЙ vision API вызов.
     * НЕ использует generateQuietPrompt — он тянет весь RP-контекст (30к токенов).
     * Использует настройки Vision из секции Гардероб (отдельная модель от image-gen).
     */
    async function swAnalyzeOutfit(base64) {
        const ctx = SillyTavern.getContext();
        const swS = ctx.extensionSettings?.['silly_wardrobe'] || {};

        const imageDataUrl = `data:image/jpeg;base64,${base64}`;
        const analyzePrompt = 'Describe the outfit/clothing visible in the attached image in 1-2 concise sentences in English. Focus ONLY on garments, colors, fabrics, accessories, shoes. Do NOT describe the person, background, or pose.';

        // Получаем vision настройки из гардероба
        const endpoint = (swS.visionEndpoint || '').trim().replace(/\/$/, '');
        const apiKey   = (swS.visionApiKey  || '').trim();
        const model    = (swS.visionModel   || '').trim();

        if (!endpoint || !apiKey || !model) {
            toastr.warning(
                'Укажи Vision endpoint / API key / модель в настройках Гардероба для авто-описания.',
                'Гардероб',
                { timeOut: 6000 }
            );
            swLog('WARN', 'Vision не настроен — нет endpoint/apiKey/model в silly_wardrobe settings');
            return null;
        }

        // Чистый изолированный вызов — БЕЗ системного промпта и БЕЗ истории чата
        // generateQuietPrompt не используется: он всегда тянет весь контекст (~30k токенов RP)
        try {
            toastr.info('Анализ образа через Vision API...', 'Гардероб', { timeOut: 12000 });

            const response = await fetch(`${endpoint}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model,
                    max_tokens: 200,
                    // Только одно сообщение — никакого системного промпта, никакой истории
                    messages: [{
                        role: 'user',
                        content: [
                            { type: 'image_url', image_url: { url: imageDataUrl } },
                            { type: 'text', text: analyzePrompt },
                        ],
                    }],
                }),
            });

            if (!response.ok) {
                const errText = await response.text().catch(() => '');
                swLog('WARN', `Vision API HTTP ${response.status}:`, errText.substring(0, 200));
                toastr.error(`Vision API ошибка ${response.status}`, 'Гардероб', { timeOut: 4000 });
                return null;
            }

            const data = await response.json();
            const raw = data?.choices?.[0]?.message?.content;
            const desc = swCleanOutfitDesc(raw);

            if (desc) {
                swLog('INFO', 'Vision API описание:', desc.substring(0, 100));
                return desc;
            }

            swLog('WARN', 'Vision API: пусто после очистки. raw:', String(raw).substring(0, 200));
            return null;

        } catch (e) {
            swLog('WARN', 'Vision API fetch failed:', e.message);
            toastr.error('Ошибка Vision API: ' + e.message, 'Гардероб', { timeOut: 4000 });
            return null;
        }
    }

    async function handleUpload() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            if (!file) return;
            const name = prompt('Название аутфита:', file.name.replace(/\.[^.]+$/, ''));
            if (name === null || !name.trim()) return;
            try {
                const s = getSettings();
                const { base64 } = await resizeImage(file, s.maxDimension);

                // Авто-анализ через ИИ
                let autoDesc = await swAnalyzeOutfit(base64);
                // Даём пользователю отредактировать или подтвердить
                const description = prompt(
                    autoDesc
                        ? 'Описание (авто-сгенерировано ИИ, можно отредактировать):'
                        : 'Описание (опционально):',
                    autoDesc || ''
                ) || '';

                addOutfit(getCharName(), currentTab, {
                    id: uid(), name: name.trim(), description: description.trim(),
                    base64, addedAt: Date.now()
                });
                renderTabContent();
                toastr.success(`«${name.trim()}» добавлен`, 'Гардероб');
            } catch (err) {
                toastr.error('Ошибка: ' + err.message, 'Гардероб');
            }
        });
        input.click();
    }

    async function handleEdit(charName, type, id) {
        const outfit = findOutfit(charName, type, id);
        if (!outfit) return;
        const newName = prompt('Название:', outfit.name);
        if (newName === null) return;

        // Предлагаем пере-анализировать через ИИ
        let currentDesc = outfit.description || '';
        const reAnalyze = confirm(
            'Пере-анализировать образ через ИИ?\n\nОК = да (описание заменится авто)\nОтмена = редактировать вручную'
        );
        if (reAnalyze) {
            const autoDesc = await swAnalyzeOutfit(outfit.base64);
            if (autoDesc) currentDesc = autoDesc;
        }

        const newDesc = prompt('Описание:', currentDesc);
        if (newDesc === null) return;
        outfit.name = newName.trim() || outfit.name;
        outfit.description = newDesc.trim();
        saveSettings();
        renderTabContent();
        swUpdatePromptInjection();
        toastr.info('Аутфит обновлён', 'Гардероб');
    }

    /* ── inline settings display ── */

    function refreshWardrobeSettingsDisplay() {
        const charName = getCharName();
        if (!charName) return;
        const active = getActiveIds();

        for (const type of ['bot', 'user']) {
            const thumb = document.querySelector(`.iig-wardrobe-active-thumb[data-type="${type}"]`);
            const label = document.querySelector(`.iig-wardrobe-active-label[data-type="${type}"]`);
            if (!thumb || !label) continue;

            const outfit = active[type] ? findOutfit(charName, type, active[type]) : null;
            if (outfit) {
                thumb.src = `data:image/jpeg;base64,${outfit.base64}`;
                thumb.style.display = 'block';
                label.textContent = outfit.name;
                label.style.color = '#6ee7b7';
            } else {
                thumb.src = '';
                thumb.style.display = 'none';
                label.textContent = 'Не надето';
                label.style.color = '';
            }
        }
    }

    /* ── Prompt injection: outfit descriptions into main RP chat ── */
    // Скопировано 1-в-1 из sillyimages.
    // Инжектит описание одежды в чат через setExtensionPrompt, чтобы ИИ
    // знал во что одет бот/юзер при написании RP-текста.

    const SW_PROMPT_KEY = 'sillywardrobe_outfit';

    // НПС с нарядом, чьё имя встречалось в последних сообщениях чата.
    const SW_NPC_SCENE_DEPTH = 6;
    function swNpcsInScene() {
        const ctx = SillyTavern.getContext();
        const npcs = (ctx.extensionSettings?.vish_image_gen?.npcReferences || [])
            .filter(n => n && n.enabled !== false && n.name && n.outfit?.description);
        if (!npcs.length) return [];
        const recent = (ctx.chat || []).slice(-SW_NPC_SCENE_DEPTH).map(m => m?.mes || '').join('\n').toLowerCase();
        return npcs.filter(n => n.name.trim().split(/\s+/).filter(w => w.length > 2)
            .some(w => recent.includes(w.toLowerCase())));
    }

    function swUpdatePromptInjection() {
        try {
            const ctx = SillyTavern.getContext();
            if (typeof ctx.setExtensionPrompt !== 'function') {
                swLog('WARN', 'setExtensionPrompt not available');
                return;
            }
            const cn = getCharName();
            // Образы берём с учётом режима (Общий / Персональный) — для бота нужен персонаж,
            // а общий гардероб юзера может работать и без выбранного персонажа.
            const botData = cn ? swGetActiveSideOutfit('bot') : null;
            const userData = swGetActiveSideOutfit('user');
            const lines = [];
            if (botData?.description) lines.push(`[${cn || 'The character'} is currently wearing: ${botData.description}]`);
            if (userData?.description) lines.push(`[{{user}} is currently wearing: ${userData.description}]`);
            for (const npc of swNpcsInScene()) lines.push(`[${npc.name} is currently wearing: ${npc.outfit.description}]`);
            const injectionText = lines.length > 0 ? lines.join('\n') : '';
            // position 1 = IN_CHAT, depth 1 = before last message (like Author's Note)
            ctx.setExtensionPrompt(SW_PROMPT_KEY, injectionText, 1, 1);
            if (injectionText) {
                swLog('INFO', `Prompt injection updated: ${lines.length} outfit(s)`);
            } else {
                swLog('INFO', 'Prompt injection cleared (no active outfits)');
            }
        } catch (e) {
            swLog('ERROR', 'Failed to update prompt injection:', e.message);
        }
    }

    /* ── public API ── */

    window.sillyWardrobe = {
        getActiveOutfitBase64(type) {
            const side = type === 'bot' ? 'bot' : 'user';
            // Общий гардероб: картинка в файле → отдаём предзагруженный кэш (синхронно).
            if (swSharedCfg(side).use()) return swSharedCache[side].b64;
            return swGetActiveSideOutfit(side)?.base64 || null;
        },
        // Async-вариант: гарантированно подгрузит base64 из файла, если кэш холодный.
        async getActiveOutfitBase64Async(type) {
            const side = type === 'bot' ? 'bot' : 'user';
            if (swSharedCfg(side).use()) { await swPreloadSharedActive(side); return swSharedCache[side].b64; }
            return swGetActiveSideOutfit(side)?.base64 || null;
        },
        getActiveOutfitDataUrl(type) {
            const b64 = this.getActiveOutfitBase64(type);
            return b64 ? `data:image/jpeg;base64,${b64}` : null;
        },
        getActiveOutfitData(type) { return swGetActiveSideOutfit(type === 'bot' ? 'bot' : 'user'); },
        openModal,
        refreshDisplay: refreshWardrobeSettingsDisplay,
        updatePromptInjection: swUpdatePromptInjection,
        preloadShared: swPreloadAllShared,
        migrateUserOutfits: () => swMigrateToShared('user'),
        migrateBotOutfits: () => swMigrateToShared('bot'),
        countPendingMigration: (side) => swCountPendingMigration(side === 'bot' ? 'bot' : 'user'),
        isReady: () => true,
    };

    // ── Мост для UI-модуля (vw-панель) ──
    // Module 3 — отдельный IIFE и не видит локальные функции этого модуля, поэтому
    // выставляем всё нужное (общий гардероб, типы, чистка) через window._swCore.
    window._swCore = {
        // Типы одежды (редактируемые)
        types: swTypes, typeIds: swTypeIds, typeOf: swTypeOf, typeMeta: swTypeMeta,
        TYPE_ICONS: SW_TYPE_ICONS, FALLBACK_TYPE: SW_FALLBACK_TYPE,
        addType: swAddType, ensureType: swEnsureType, renameType: swRenameType, setTypeIcon: swSetTypeIcon, deleteType: swDeleteType,
        imgSrc: swImgSrc,
        viewForSide: swViewForSide,
        isShared: (side) => swSharedCfg(side).use(),
        setShared: (side, v) => { swSharedCfg(side).setUse(!!v); saveSettings(); },
        getSharedActiveId: swGetSharedActiveId,
        preloadSharedActive: swPreloadSharedActive,
        preloadAll: swPreloadAllShared,
        countPending: swCountPendingMigration,
        autoWearFromCurrent: swAutoWearSharedFromCurrent,
        migrate: swMigrateToShared,
        activeSideOutfit: swGetActiveSideOutfit,
        scanOrphans: swScanOrphans,
        deleteFiles: swDeleteFiles,
        updateInjection: swUpdatePromptInjection,
        analyzeOutfit: (b64) => swAnalyzeOutfit(b64),
        resizeImage: (file, maxDim) => resizeImage(file, maxDim),
        compress: (b64, max, q) => (typeof compressBase64Image === 'function' ? compressBase64Image(b64, max, q) : Promise.resolve(b64)),
        saveFile: (b64, label) => (typeof saveRefImageToFile === 'function' ? saveRefImageToFile(b64, label) : Promise.reject(new Error('saveRefImageToFile unavailable'))),
        maxDim: () => getSettings().maxDimension || 512,
        isReady: () => true,
    };

    /* ── init ── */

    const ctx = SillyTavern.getContext();
    getSettings();

    ctx.eventSource.on(ctx.event_types.APP_READY, () => {
        swLog('INFO', 'SillyWardrobe loaded (settings-integrated mode)');
        setTimeout(() => { swPreloadAllShared(); swUpdatePromptInjection(); }, 500);
    });

    ctx.eventSource.on(ctx.event_types.CHAT_CHANGED, () => {
        // Надетое в общем гардеробе — per-chat: при смене чата перечитываем активный образ.
        setTimeout(() => { swPreloadAllShared(); swUpdatePromptInjection(); refreshWardrobeSettingsDisplay(); }, 350);
    });

    // ⚡ Перезаписываем инжект перед КАЖДОЙ генерацией — страховка от очистки контекста / гонок.
    const _swGenEvents = ['GENERATION_STARTED', 'GENERATE_BEFORE_COMBINE_PROMPTS', 'GENERATION_AFTER_COMMANDS', 'MESSAGE_SENT'];
    for (const evName of _swGenEvents) {
        const ev = ctx.event_types?.[evName];
        if (ev) ctx.eventSource.on(ev, () => { try { swUpdatePromptInjection(); } catch (e) { swLog('WARN', `re-inject on ${evName} failed:`, e.message); } });
    }

    swLog('INFO', 'SillyWardrobe initialized (shared wardrobe + types + cleanup)');
})();



/* ╔═══════════════════════════════════════════════════════════════╗
   ║  MODULE 2 — Inline Image Generation                          ║
   ║  Base: notsosillynotsoimages by aceeenvw                     ║
   ║  + wardrobe integration                                      ║
   ╚═══════════════════════════════════════════════════════════════╝ */

// Свой ключ настроек: под 'inline_image_gen' живёт sillyimages, и вместе
// они перезаписывали бы друг другу настройки.
const MODULE_NAME = 'vish_image_gen';
const LEGACY_MODULE_NAME = 'inline_image_gen';

const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const FETCH_TIMEOUT = IS_IOS ? 180000 : 300000;

// Ошибка «пользователь нажал Стоп»: её не повторяем и не считаем ошибкой генерации.
function createStopError() {
    const error = new Error('Генерация остановлена');
    error.isStopped = true;
    return error;
}

function robustFetch(url, options = {}) {
    const { signal: stopSignal, ...fetchOptions } = options;
    if (stopSignal?.aborted) return Promise.reject(createStopError());
    if (!IS_IOS) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
        stopSignal?.addEventListener('abort', () => controller.abort(), { once: true });
        return fetch(url, { ...fetchOptions, signal: controller.signal })
            .then(r => { clearTimeout(timeoutId); return r; })
            .catch(e => {
                clearTimeout(timeoutId);
                if (stopSignal?.aborted) throw createStopError();
                if (e.name === 'AbortError') throw new Error('Request timed out after 5 minutes');
                throw e;
            });
    }
    options = fetchOptions;
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        stopSignal?.addEventListener('abort', () => xhr.abort(), { once: true });
        xhr.open(options.method || 'GET', url);
        xhr.timeout = FETCH_TIMEOUT;
        xhr.responseType = 'text';
        if (options.headers) {
            for (const [key, value] of Object.entries(options.headers)) xhr.setRequestHeader(key, value);
        }
        xhr.onload = () => resolve({
            ok: xhr.status >= 200 && xhr.status < 300,
            status: xhr.status, statusText: xhr.statusText,
            text: () => Promise.resolve(xhr.responseText),
            json: () => Promise.resolve(JSON.parse(xhr.responseText)),
            headers: { get: (name) => xhr.getResponseHeader(name) }
        });
        xhr.ontimeout = () => reject(new Error('Request timed out after 3 minutes (iOS)'));
        xhr.onerror = () => reject(new Error('Network error (iOS)'));
        xhr.onabort = () => reject(stopSignal?.aborted ? createStopError() : new Error('Request aborted (iOS)'));
        xhr.send(options.body || null);
    });
}

const processingMessages = new Set();

let sessionGenCount = 0;
let sessionErrorCount = 0;

function updateSessionStats() {
    const el = document.getElementById('iig_session_stats');
    if (!el) return;
    if (sessionGenCount === 0 && sessionErrorCount === 0) { el.textContent = ''; return; }
    const parts = [];
    if (sessionGenCount > 0) parts.push(`${sessionGenCount} сгенерировано`);
    if (sessionErrorCount > 0) parts.push(`${sessionErrorCount} ошибок`);
    el.textContent = `Сессия: ${parts.join(' · ')}`;
}

const logBuffer = [];
const MAX_LOG_ENTRIES = 200;

function iigLog(level, ...args) {
    const timestamp = new Date().toISOString();
    const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    logBuffer.push(`[${timestamp}] [${level}] ${message}`);
    if (logBuffer.length > MAX_LOG_ENTRIES) logBuffer.shift();
    if (level === 'ERROR') console.error('[IIG]', ...args);
    else if (level === 'WARN') console.warn('[IIG]', ...args);
    else console.log('[IIG]', ...args);
}

function exportLogs() {
    const blob = new Blob([logBuffer.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `iig-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toastr.success('Логи экспортированы', 'Генерация картинок');
}

const defaultSettings = Object.freeze({
    enabled: true,
    apiType: 'openai',
    endpoint: '',
    apiKey: '',
    model: '',
    size: '1024x1024',
    quality: 'standard',
    maxRetries: 0,
    retryDelay: 1000,
    aspectRatio: '1:1',
    imageSize: '1K',
    naisteraAspectRatio: '1:1',
    naisteraPreset: '',
    imageContextEnabled: false,
    imageContextCount: 1,
    npcReferences: [],
    // Внешние блоки: теги картинок в message.extra.extblocks (их пишут
    // расширения-трекеры, отображаются через message.extra.display_text).
    externalBlocks: false,
    // Библиотека стилей: [{ id, name, value, imagePath }]. Формат совпадает
    // с sillyimages, поэтому его стили переносятся при копировании настроек.
    styles: [],
    activeStyleId: '',
    // Инструкция перед референсами (как в sillyimages): уходит в начало промпта,
    // только когда к запросу прикреплены картинки-референсы.
    refInstructionEnabled: true,
    refInstruction: '',
    // Профили подключения: [{ id, name, ...CONNECTION_FIELDS }].
    connectionProfiles: [],
    activeConnectionProfileId: '',
});

const MAX_CONTEXT_IMAGES = 3;

function normalizeImageContextCount(value) {
    const n = Number.parseInt(String(value ?? '').trim(), 10);
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(n, MAX_CONTEXT_IMAGES);
}

// Извлекает URL-ы уже сгенерированных картинок из текста сообщения
function extractGeneratedImageUrlsFromText(text) {
    const urls = [];
    const seen = new Set();
    const rawText = String(text || '');
    const legacyMatches = Array.from(rawText.matchAll(/\[IMG:✓:([^\]]+)\]/g));
    for (let i = legacyMatches.length - 1; i >= 0; i--) {
        const src = String(legacyMatches[i][1] || '').trim();
        if (!src || seen.has(src)) continue;
        seen.add(src); urls.push(src);
    }
    if (!rawText.includes('<img')) return urls;
    const template = document.createElement('template');
    template.innerHTML = rawText;
    const nodes = Array.from(template.content.querySelectorAll('img[data-iig-instruction]')).reverse();
    for (const node of nodes) {
        const src = String(node.getAttribute('src') || '').trim();
        if (!src || src.startsWith('data:') || src.includes('[IMG:') || src.endsWith('/error.svg') || seen.has(src)) continue;
        seen.add(src); urls.push(src);
    }
    return urls;
}

// Ищет URL-ы предыдущих сгенерированных картинок в истории чата
function getPreviousGeneratedImageUrls(messageId, requestedCount) {
    const count = normalizeImageContextCount(requestedCount);
    if (!Number.isInteger(messageId) || messageId <= 0) return [];
    const context = SillyTavern.getContext();
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const urls = [];
    const seen = new Set();
    for (let idx = messageId - 1; idx >= 0 && urls.length < count; idx--) {
        const message = chat[idx];
        if (!message || message.is_user || message.is_system) continue;
        const sourceText = getSettings().externalBlocks
            ? `${message.mes || ''}\n${message.extra?.extblocks || ''}`
            : (message.mes || '');
        for (const url of extractGeneratedImageUrlsFromText(sourceText)) {
            if (seen.has(url)) continue;
            seen.add(url); urls.push(url);
            if (urls.length >= count) break;
        }
    }
    return urls;
}

// Конвертирует URL-ы предыдущих картинок в base64 / dataUrl для отправки в API
async function collectPreviousContextReferences(messageId, format, requestedCount) {
    const urls = getPreviousGeneratedImageUrls(messageId, requestedCount);
    if (urls.length === 0) return [];
    const convert = format === 'dataUrl' ? imageUrlToDataUrl : imageUrlToBase64;
    const converted = await Promise.all(urls.map(url => convert(url)));
    return converted.filter(Boolean);
}

const IMAGE_MODEL_KEYWORDS = [
    'dall-e', 'midjourney', 'mj', 'journey', 'stable-diffusion', 'sdxl', 'flux',
    'imagen', 'drawing', 'paint', 'image', 'seedream', 'hidream', 'dreamshaper',
    'ideogram', 'nano-banana', 'gpt-image', 'wanx', 'qwen'
];
const VIDEO_MODEL_KEYWORDS = [
    'sora', 'kling', 'jimeng', 'veo', 'pika', 'runway', 'luma',
    'video', 'gen-3', 'minimax', 'cogvideo', 'mochi', 'seedance',
    'vidu', 'wan-ai', 'hunyuan', 'hailuo'
];

function isImageModel(modelId) {
    const mid = modelId.toLowerCase();
    for (const kw of VIDEO_MODEL_KEYWORDS) { if (mid.includes(kw)) return false; }
    if (mid.includes('vision') && mid.includes('preview')) return false;
    for (const kw of IMAGE_MODEL_KEYWORDS) { if (mid.includes(kw)) return true; }
    return false;
}

function isGeminiModel(modelId) {
    return modelId.toLowerCase().includes('nano-banana');
}

function getSettings() {
    const context = SillyTavern.getContext();
    if (!context.extensionSettings[MODULE_NAME]) {
        // Первый запуск: один раз копируем старые настройки (vish раньше
        // хранил их под ключом sillyimages). Оригинал не трогаем.
        const legacy = context.extensionSettings[LEGACY_MODULE_NAME];
        context.extensionSettings[MODULE_NAME] = legacy && typeof legacy === 'object'
            ? structuredClone(legacy)
            : structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(context.extensionSettings[MODULE_NAME], key)) {
            const value = defaultSettings[key];
            context.extensionSettings[MODULE_NAME][key] = value && typeof value === 'object' ? structuredClone(value) : value;
        }
    }
    return context.extensionSettings[MODULE_NAME];
}

function saveSettings() {
    const context = SillyTavern.getContext();
    syncActiveConnectionProfile();
    if (typeof window.saveSettings === 'function') {
        try { window.saveSettings(); } catch(e) { context.saveSettingsDebounced(); }
    } else {
        context.saveSettingsDebounced();
    }
    persistRefsToLocalStorage();
}

function saveSettingsNow() { saveSettings(); }

/* ── Профили подключения ── */

// Поля, которые хранит профиль. Всё остальное (стили, НПС, внешние блоки)
// общее для всех профилей.
const CONNECTION_FIELDS = Object.freeze([
    'apiType', 'endpoint', 'apiKey', 'model', 'size', 'quality',
    'aspectRatio', 'imageSize', 'naisteraAspectRatio', 'naisteraPreset',
    'sendCharAvatar', 'sendUserAvatar', 'userAvatarFile',
    'naisteraSendCharAvatar', 'naisteraSendUserAvatar',
]);

function makeProfileId() {
    return `iig-profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function extractConnectionFields(settings = getSettings()) {
    const snapshot = {};
    for (const key of CONNECTION_FIELDS) snapshot[key] = settings[key];
    return snapshot;
}

// Нормализует профили на месте. Первый запуск: профиль «Основной» из
// текущих настроек. Поля, которых нет в профиле (например, из профилей
// sillyimages), берутся из текущих настроек.
function getConnectionProfiles(settings = getSettings()) {
    if (!Array.isArray(settings.connectionProfiles)) settings.connectionProfiles = [];
    settings.connectionProfiles = settings.connectionProfiles.filter(p => p && typeof p === 'object');
    if (settings.connectionProfiles.length === 0) {
        const id = makeProfileId();
        settings.connectionProfiles.push({ id, name: 'Основной', ...extractConnectionFields(settings) });
        settings.activeConnectionProfileId = id;
    }
    for (const profile of settings.connectionProfiles) {
        profile.id = String(profile.id || '') || makeProfileId();
        profile.name = String(profile.name || '').trim() || 'Профиль';
        for (const key of Object.keys(profile)) {
            if (key !== 'id' && key !== 'name' && !CONNECTION_FIELDS.includes(key)) delete profile[key];
        }
        for (const key of CONNECTION_FIELDS) {
            if (!Object.hasOwn(profile, key)) profile[key] = settings[key];
        }
    }
    if (!settings.connectionProfiles.some(p => p.id === settings.activeConnectionProfileId)) {
        settings.activeConnectionProfileId = settings.connectionProfiles[0].id;
    }
    return settings.connectionProfiles;
}

function getActiveConnectionProfile(settings = getSettings()) {
    return getConnectionProfiles(settings).find(p => p.id === settings.activeConnectionProfileId) || null;
}

// Текущие поля всегда пишутся в активный профиль, поэтому отдельная кнопка
// «Сохранить» не нужна и при переключении ничего не теряется.
function syncActiveConnectionProfile(settings = getSettings()) {
    const profile = getActiveConnectionProfile(settings);
    if (profile) Object.assign(profile, extractConnectionFields(settings));
}

function loadConnectionProfile(profileId, settings = getSettings()) {
    syncActiveConnectionProfile(settings);
    const profile = getConnectionProfiles(settings).find(p => p.id === profileId);
    if (!profile) return null;
    for (const key of CONNECTION_FIELDS) settings[key] = profile[key];
    settings.activeConnectionProfileId = profile.id;
    saveSettings();
    return profile;
}

function createConnectionProfile(name, settings = getSettings()) {
    syncActiveConnectionProfile(settings);
    const profile = {
        id: makeProfileId(),
        name: String(name || '').trim() || `Профиль ${getConnectionProfiles(settings).length + 1}`,
        ...extractConnectionFields(settings),
    };
    settings.connectionProfiles.push(profile);
    settings.activeConnectionProfileId = profile.id;
    saveSettings();
    return profile;
}

function renameConnectionProfile(profileId, name, settings = getSettings()) {
    const profile = getConnectionProfiles(settings).find(p => p.id === profileId);
    const trimmed = String(name || '').trim();
    if (!profile || !trimmed) return null;
    profile.name = trimmed;
    saveSettings();
    return profile;
}

// Последний профиль не удаляется. После удаления активного загружается первый оставшийся.
function removeConnectionProfile(profileId, settings = getSettings()) {
    const profiles = getConnectionProfiles(settings);
    if (profiles.length <= 1) return false;
    const index = profiles.findIndex(p => p.id === profileId);
    if (index === -1) return false;
    const wasActive = settings.activeConnectionProfileId === profileId;
    profiles.splice(index, 1);
    if (wasActive) {
        const next = profiles[0];
        for (const key of CONNECTION_FIELDS) settings[key] = next[key];
        settings.activeConnectionProfileId = next.id;
    }
    saveSettings();
    return true;
}

async function askText(title, defaultValue = '') {
    const popup = SillyTavern.getContext().Popup;
    if (typeof popup?.show?.input === 'function') return await popup.show.input(title, '', defaultValue);
    return window.prompt(title, defaultValue);
}

async function askConfirm(title, text) {
    const popup = SillyTavern.getContext().Popup;
    if (typeof popup?.show?.confirm === 'function') return await popup.show.confirm(title, text);
    return window.confirm(`${title}\n${text}`);
}

// Для быстрых настроек (Module 4): они живут в отдельном IIFE.
window._iigConnectionProfiles = {
    list: () => getConnectionProfiles().map(p => ({ id: p.id, name: p.name })),
    activeId: () => getSettings().activeConnectionProfileId,
    load: (id) => { const p = loadConnectionProfile(id); if (p) applyConnectionFieldsToUI(); return p; },
};

const LS_KEY = 'iig_npc_refs_v3';

function persistRefsToLocalStorage() {
    try {
        const settings = getSettings();
        const refs = JSON.parse(JSON.stringify(settings.npcReferences || {}));
        localStorage.setItem(LS_KEY, JSON.stringify(refs));
    } catch(e) { iigLog('WARN', 'persistRefsToLocalStorage failed:', e.message); }
}

function restoreRefsFromLocalStorage() {
    try {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) return;
        const backup = JSON.parse(raw);
        if (!backup || typeof backup !== 'object') return;
        const settings = getSettings();
        settings.npcReferences = backup;
    } catch(e) { iigLog('WARN', 'restoreRefsFromLocalStorage failed:', e.message); }
}

function initMobileSaveListeners() {
    const flush = () => {
        persistRefsToLocalStorage();
        try { SillyTavern.getContext().saveSettingsDebounced(); } catch(e) {}
        if (typeof window.saveSettings === 'function') { try { window.saveSettings(); } catch(e) {} }
    };
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flush();
    });
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
}

function getCurrentCharacterRefs() {
    const settings = getSettings();
    if (!settings.charRef) settings.charRef = { name: '', imageBase64: '', imagePath: '' };
    if (!settings.userRef) settings.userRef = { name: '', imageBase64: '', imagePath: '' };
    if (!Array.isArray(settings.npcReferences)) settings.npcReferences = [];
    return settings;
}

/* ── Стили ── */

function makeStyleId() {
    return `iig-style-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Нормализует список стилей на месте (объекты не пересоздаются, чтобы
// ссылки из UI оставались живыми).
function getStyles(settings = getSettings()) {
    if (!Array.isArray(settings.styles)) settings.styles = [];
    settings.styles = settings.styles.filter(st => st && typeof st === 'object');
    for (const st of settings.styles) {
        st.id = String(st.id || '') || makeStyleId();
        st.name = String(st.name || '').trim() || 'Стиль';
        st.value = String(st.value || '');
        st.imagePath = String(st.imagePath || '');
    }
    if (!settings.styles.some(st => st.id === settings.activeStyleId)) settings.activeStyleId = '';
    return settings.styles;
}

function getActiveStyle(settings = getSettings()) {
    return getStyles(settings).find(st => st.id === settings.activeStyleId) || null;
}

// Активный стиль из библиотеки важнее style из тега: так стиль не скачет
// от картинки к картинке, даже если LLM пишет его по-разному.
function resolveEffectiveStyle(tagStyle, settings = getSettings()) {
    const libraryStyle = String(getActiveStyle(settings)?.value || '').trim();
    return libraryStyle || String(tagStyle || '').trim();
}

/* ── Инструкция перед референсами ── */

const DEFAULT_REF_INSTRUCTION = '[CRITICAL: The reference image(s) above show the EXACT appearance of the character(s). You MUST precisely copy their: face structure, eye color, hair color and style, skin tone, body type, clothing, and all distinctive features. Do not deviate from the reference appearances.]';

// Пустое поле = стандартный текст; выключено = ничего.
function getRefInstruction(settings = getSettings()) {
    if (settings.refInstructionEnabled === false) return '';
    return String(settings.refInstruction || '').trim() || DEFAULT_REF_INSTRUCTION;
}

/* ── Лимит референсов под модель ── */

// Сколько картинок-референсов модель реально обрабатывает (по докам Google).
// Для незнакомых моделей оставляем прежние 4.
function getMaxReferenceImages(settings = getSettings()) {
    const id = String(settings.model || '').toLowerCase().trim();
    if (settings.apiType === 'gemini' || isGeminiModel(id)) {
        if (id.startsWith('gemini-3.1-flash-image') || id.includes('nano-banana-2')) return 14;
        if (id.startsWith('gemini-3-pro-image') || id.includes('nano-banana-pro')) return 11;
        if (id.startsWith('gemini-2.5-flash-image') || id.includes('nano-banana')) return 3;
    }
    return 4;
}

function matchNpcReferences(prompt, npcList) {
    if (!prompt || !npcList || npcList.length === 0) return [];
    const lowerPrompt = prompt.toLowerCase();
    const matched = [];
    for (const npc of npcList) {
        const hasFace = !!(npc?.imagePath || npc?.imageBase64);
        const hasOutfit = !!(npc?.outfit?.imagePath || npc?.outfit?.description);
        if (!npc || npc.enabled === false || !npc.name || (!hasFace && !hasOutfit)) continue;
        const words = npc.name.trim().split(/\s+/).filter(w => w.length > 2);
        if (words.length === 0) continue;
        if (words.some(word => lowerPrompt.includes(word.toLowerCase()))) {
            matched.push({ name: npc.name, imageBase64: npc.imageBase64, imagePath: npc.imagePath, outfit: npc.outfit || null });
        }
    }
    return matched;
}

async function fetchModels() {
    const settings = getSettings();
    if (!settings.endpoint || !settings.apiKey) return [];
    const url = `${settings.endpoint.replace(/\/$/, '')}/v1/models`;
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${settings.apiKey}` }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        return (data.data || []).filter(m => isImageModel(m.id)).map(m => m.id);
    } catch (error) {
        toastr.error(`Ошибка загрузки моделей: ${error.message}`, 'Генерация картинок');
        return [];
    }
}

function compressBase64Image(rawBase64, maxDim = 768, quality = 0.8) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            let w = img.width, h = img.height;
            if (w > maxDim || h > maxDim) {
                const scale = maxDim / Math.max(w, h);
                w = Math.round(w * scale);
                h = Math.round(h * scale);
            }
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL('image/jpeg', quality).split(',')[1]);
        };
        img.onerror = () => reject(new Error('Failed to load image for compression'));
        img.src = 'data:image/jpeg;base64,' + rawBase64;
    });
}

async function imageUrlToBase64(url) {
    try {
        const response = await fetch(url);
        const blob = await response.blob();
        return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (error) { return null; }
}

async function imageUrlToDataUrl(url) {
    try {
        const response = await fetch(url);
        const blob = await response.blob();
        return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (error) { return null; }
}

/* ── Avatar helpers ── */

async function fetchUserAvatars() {
    try {
        const context = SillyTavern.getContext();
        const response = await fetch('/api/avatars/get', { method: 'POST', headers: context.getRequestHeaders() });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } catch (e) { iigLog('WARN', 'fetchUserAvatars failed:', e.message); return []; }
}


async function getCharacterAvatarBase64() {
    try {
        const context = SillyTavern.getContext();
        if (context.characterId === undefined || context.characterId === null) return null;
        if (typeof context.getCharacterAvatar === 'function') {
            const url = context.getCharacterAvatar(context.characterId);
            if (url) { const b = await imageUrlToBase64(url); if (b) return b; }
        }
        const character = context.characters?.[context.characterId];
        if (character?.avatar) return await imageUrlToBase64(`/characters/${encodeURIComponent(character.avatar)}`);
        return null;
    } catch (e) { iigLog('WARN', 'getCharacterAvatarBase64 failed:', e.message); return null; }
}

async function getCharacterAvatarDataUrl() {
    try {
        const context = SillyTavern.getContext();
        if (context.characterId === undefined || context.characterId === null) return null;
        if (typeof context.getCharacterAvatar === 'function') {
            const url = context.getCharacterAvatar(context.characterId);
            if (url) { const d = await imageUrlToDataUrl(url); if (d) return d; }
        }
        const character = context.characters?.[context.characterId];
        if (character?.avatar) return await imageUrlToDataUrl(`/characters/${encodeURIComponent(character.avatar)}`);
        return null;
    } catch (e) { iigLog('WARN', 'getCharacterAvatarDataUrl failed:', e.message); return null; }
}

async function getUserAvatarBase64() {
    try {
        const context = SillyTavern.getContext();
        const settings = getSettings();
        const currentAvatar = context.user_avatar;
        if (currentAvatar) {
            const b = await imageUrlToBase64(`/User Avatars/${encodeURIComponent(currentAvatar)}`);
            if (b) return b;
        }
        if (settings.userAvatarFile) return await imageUrlToBase64(`/User Avatars/${encodeURIComponent(settings.userAvatarFile)}`);
        return null;
    } catch (e) { iigLog('WARN', 'getUserAvatarBase64 failed:', e.message); return null; }
}

async function getUserAvatarDataUrl() {
    try {
        const context = SillyTavern.getContext();
        const settings = getSettings();
        const currentAvatar = context.user_avatar;
        if (currentAvatar) {
            const d = await imageUrlToDataUrl(`/User Avatars/${encodeURIComponent(currentAvatar)}`);
            if (d) return d;
        }
        if (settings.userAvatarFile) return await imageUrlToDataUrl(`/User Avatars/${encodeURIComponent(settings.userAvatarFile)}`);
        return null;
    } catch (e) { iigLog('WARN', 'getUserAvatarDataUrl failed:', e.message); return null; }
}

async function saveImageToFile(dataUrl) {
    const context = SillyTavern.getContext();
    if (typeof dataUrl !== 'string') throw new Error(`saveImageToFile: expected string, got ${typeof dataUrl}`);

    if (dataUrl.startsWith('http://') || dataUrl.startsWith('https://')) {
        const fetched = await fetch(dataUrl);
        if (!fetched.ok) throw new Error(`Failed to fetch image URL: ${fetched.status}`);
        const blob = await fetched.blob();
        const base64Data = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
        const format = blob.type.split('/')[1] || 'png';
        let charName = 'generated';
        if (context.characterId !== undefined && context.characters?.[context.characterId]) {
            charName = context.characters[context.characterId].name || 'generated';
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const response = await fetch('/api/images/upload', {
            method: 'POST', headers: context.getRequestHeaders(),
            body: JSON.stringify({ image: base64Data, format, ch_name: charName, filename: `iig_${timestamp}` })
        });
        if (!response.ok) { const e = await response.json().catch(() => ({ error: 'Unknown' })); throw new Error(e.error || `Upload failed: ${response.status}`); }
        return (await response.json()).path;
    }

    const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) throw new Error(`Invalid data URL format (got: ${String(dataUrl).substring(0, 80)})`);

    const format = match[1];
    const base64Data = match[2];
    let charName = 'generated';
    if (context.characterId !== undefined && context.characters?.[context.characterId]) {
        charName = context.characters[context.characterId].name || 'generated';
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const response = await fetch('/api/images/upload', {
        method: 'POST', headers: context.getRequestHeaders(),
        body: JSON.stringify({ image: base64Data, format, ch_name: charName, filename: `iig_${timestamp}` })
    });
    if (!response.ok) { const e = await response.json().catch(() => ({ error: 'Unknown' })); throw new Error(e.error || `Upload failed: ${response.status}`); }
    const result = await response.json();
    iigLog('INFO', 'Image saved to:', result.path);
    return result.path;
}

async function saveRefImageToFile(base64Data, label) {
    const context = SillyTavern.getContext();
    const safeName = label.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 40);
    const response = await fetch('/api/images/upload', {
        method: 'POST', headers: context.getRequestHeaders(),
        body: JSON.stringify({ image: base64Data, format: 'jpeg', ch_name: 'iig_refs', filename: `iig_ref_${safeName}_${Date.now()}` })
    });
    if (!response.ok) { const e = await response.json().catch(() => ({ error: 'Unknown' })); throw new Error(e.error || `Upload failed: ${response.status}`); }
    return (await response.json()).path;
}

async function loadRefImageAsBase64(path) {
    try {
        const response = await fetch(path);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch(e) { iigLog('WARN', `loadRefImageAsBase64 failed for ${path}:`, e.message); return null; }
}

/* ── API: VoidAI ── */
async function generateImageVoid(prompt, style, options = {}) {
    const settings = getSettings();
    const url = `${settings.endpoint.replace(/\/$/, '')}/v1/chat/completions`;
    const fullPrompt = style ? `[Style: ${style}] ${prompt}` : prompt;
    rememberFinalPrompt(fullPrompt);
    const body = {
        model: settings.model,
        messages: [{ role: 'user', content: fullPrompt }],
        size: settings.size || '1024x1024',
        quality: options.quality || settings.quality || 'standard',
        n: 1
    };
    const response = await robustFetch(url, {
        method: 'POST',
        signal: options.signal,
        headers: { 'Authorization': `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!response.ok) { const text = await response.text(); throw new Error(`API Error (${response.status}): ${text}`); }
    const result = await response.json();
    if (result.data?.length > 0) {
        const img = result.data[0];
        if (img.b64_json) return `data:image/png;base64,${img.b64_json}`;
        if (img.url) return img.url;
    }
    const choice = result.choices?.[0];
    if (choice) {
        const imgList = choice.message?.images || choice.images || result.images || [];
        if (imgList.length > 0) {
            const img = imgList[0];
            const toStr = (v) => (typeof v === 'string' ? v : null);
            const candidates = [
                toStr(img?.b64_json) && `data:image/png;base64,${img.b64_json}`,
                toStr(img?.image_url?.url),
                toStr(img?.url),
                toStr(img?.base64) && `data:image/png;base64,${img.base64}`,
                typeof img === 'string' && img,
            ].filter(Boolean);
            if (candidates.length > 0) {
                const val = candidates[0];
                return val.startsWith('http') || val.startsWith('data:') ? val : `data:image/png;base64,${val}`;
            }
        }
    }
    const raw = JSON.stringify(result);
    const b64match = raw.match(/"b64_json":"([^"]+)"/);
    if (b64match) return `data:image/png;base64,${b64match[1]}`;
    const urlmatch = raw.match(/"url":"(https?:\/\/[^"]+)"/);
    if (urlmatch) return urlmatch[1];
    throw new Error('VoidAI: не удалось найти изображение в ответе');
}

/* ── API: OpenAI ── */
async function generateImageOpenAI(prompt, style, referenceImages = [], options = {}) {
    const settings = getSettings();
    const url = `${settings.endpoint.replace(/\/$/, '')}/v1/images/generations`;
    const fullPrompt = style ? `[Style: ${style}] ${prompt}` : prompt;
    rememberFinalPrompt(fullPrompt);
    let size = settings.size;
    if (options.aspectRatio) {
        if (options.aspectRatio === '16:9') size = '1536x1024';
        else if (options.aspectRatio === '9:16') size = '1024x1536';
        else if (options.aspectRatio === '1:1') size = '1024x1024';
    }
    const body = {
        model: settings.model, prompt: fullPrompt, n: 1,
        size, quality: options.quality || settings.quality, response_format: 'b64_json'
    };
    if (referenceImages.length > 0) body.image = `data:image/png;base64,${referenceImages[0]}`;
    const response = await robustFetch(url, {
        method: 'POST',
        signal: options.signal,
        headers: { 'Authorization': `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!response.ok) { const text = await response.text(); throw new Error(`API Error (${response.status}): ${text}`); }
    const result = await response.json();
    const dataList = result.data || [];
    if (dataList.length === 0) {
        if (result.url) return result.url;
        if (result.b64_json) return `data:image/png;base64,${result.b64_json}`;
        throw new Error('No image data in response');
    }
    const imageObj = dataList[0];
    if (imageObj.b64_json) return `data:image/png;base64,${imageObj.b64_json}`;
    return imageObj.url;
}

/* ── API: Gemini / nano-banana ── */
const VALID_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const VALID_IMAGE_SIZES = ['1K', '2K', '4K'];

async function generateImageGemini(prompt, style, referenceImages = [], options = {}) {
    const settings = getSettings();
    const model = settings.model;
    const url = `${settings.endpoint.replace(/\/$/, '')}/v1beta/models/${model}:generateContent`;
    let aspectRatio = options.aspectRatio || settings.aspectRatio || '1:1';
    if (!VALID_ASPECT_RATIOS.includes(aspectRatio)) aspectRatio = '1:1';
    let imageSize = options.imageSize || settings.imageSize || '1K';
    if (!VALID_IMAGE_SIZES.includes(imageSize)) imageSize = '1K';

    const refLabels = options.refLabels || [];
    const labelMap = {
        'char_face':    '⬇️ CHARACTER FACE REFERENCE — copy this face exactly:',
        'user_face':    '⬇️ USER FACE REFERENCE — copy this face exactly:',
        'char_outfit':  '⬇️ CHARACTER OUTFIT REFERENCE — copy this clothing:',
        'user_outfit':  '⬇️ USER OUTFIT REFERENCE — copy this clothing:',
        'context':      '⬇️ SCENE CONTEXT (for style/mood consistency):',
        'style':        '⬇️ ART STYLE REFERENCE — copy only the rendering style:',
    };

    const parts = [];
    const sliced = referenceImages.slice(0, getMaxReferenceImages(settings));
    for (let i = 0; i < sliced.length; i++) {
        const label = refLabels[i] || 'reference';
        let labelText = labelMap[label] || '⬇️ REFERENCE IMAGE:';
        if (label.startsWith('npc_face:')) labelText = `⬇️ ${label.slice(9).toUpperCase()} FACE REFERENCE — copy this face exactly:`;
        else if (label.startsWith('npc_outfit:')) labelText = `⬇️ ${label.slice(11).toUpperCase()} OUTFIT REFERENCE — ${label.slice(11)} must wear exactly this clothing:`;
        parts.push({ text: labelText });
        parts.push({ inlineData: { mimeType: 'image/jpeg', data: sliced[i] } });
    }

    // Build dynamic instruction block based on what refs are actually present
    const hasFaces   = refLabels.some(l => l.endsWith('_face') || l.startsWith('npc_face:'));
    const hasOutfits = refLabels.some(l => l.endsWith('_outfit') || l.startsWith('npc_outfit:'));
    const hasContext = refLabels.includes('context');
    const hasStyleRef = refLabels.includes('style');

    let refInstruction = '';
    if (sliced.length > 0) {
        const rules = [];
        if (hasFaces)   rules.push('FACE CONSISTENCY: You MUST precisely replicate the facial features (face structure, eye color/shape, hair color/style/length, skin tone, facial hair, age) from the FACE REFERENCE images. These faces must be recognizable as the same people across all generated images. This is the HIGHEST priority.');
        if (hasOutfits) rules.push('OUTFIT ACCURACY: The characters must wear EXACTLY the clothing shown in the OUTFIT REFERENCE images — same garments, colors, fabrics, accessories. Do not invent or change any clothing details.');
        if (hasContext) rules.push('STYLE CONSISTENCY: Match the art style, lighting, color palette, and rendering quality of the CONTEXT reference images. The generated image should look like it belongs to the same series.');
        if (hasStyleRef) rules.push('ART STYLE: Match the rendering technique, color palette, lighting and linework of the ART STYLE REFERENCE image. Do NOT copy its characters, clothing, objects or composition.');
        if (!hasContext && style) rules.push(`STYLE: Generate in "${style}" style consistently. Do not mix styles.`);
        refInstruction = `[STRICT IMAGE GENERATION RULES]\n${rules.join('\n')}\n[END RULES]\n\n`;
    }

    let fullPrompt = style ? `[Style: ${style}] ${prompt}` : prompt;
    const userRefInstruction = sliced.length > 0 ? getRefInstruction(settings) : '';
    fullPrompt = `${userRefInstruction ? `${userRefInstruction}\n\n` : ''}${refInstruction}${fullPrompt}`;
    rememberFinalPrompt(fullPrompt);
    parts.push({ text: fullPrompt });
    const body = {
        contents: [{ role: 'user', parts }],
        generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: { aspectRatio, imageSize }
        }
    };
    const response = await robustFetch(url, {
        method: 'POST',
        signal: options.signal,
        headers: { 'Authorization': `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!response.ok) { const text = await response.text(); throw new Error(`API Error (${response.status}): ${text}`); }
    const result = await response.json();
    const candidates = result.candidates || [];
    if (candidates.length === 0) {
        const blockReason = result.promptFeedback?.blockReason;
        throw new Error(`No candidates in response${blockReason ? ` (blockReason: ${blockReason})` : ''}`);
    }
    const responseParts = candidates[0].content?.parts || [];
    for (const part of responseParts) {
        if (part.inlineData) return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
        if (part.inline_data) return `data:${part.inline_data.mime_type};base64,${part.inline_data.data}`;
    }
    const finishReason = candidates[0].finishReason;
    throw new Error(`No image found in Gemini response${finishReason && finishReason !== 'STOP' ? ` (${finishReason})` : ''}`);
}

/* ── API: Naistera ── */
async function generateImageNaistera(prompt, style, options = {}) {
    const settings = getSettings();
    const endpoint = settings.endpoint.replace(/\/$/, '');
    const url = endpoint.endsWith('/api/generate') ? endpoint : `${endpoint}/api/generate`;
    const referenceImages = options.referenceImages || [];
    let fullPrompt = style ? `[Style: ${style}] ${prompt}` : prompt;
    const userRefInstruction = referenceImages.length > 0 ? getRefInstruction(settings) : '';
    if (userRefInstruction) fullPrompt = `${userRefInstruction}\n\n${fullPrompt}`;
    rememberFinalPrompt(fullPrompt);
    const aspectRatio = options.aspectRatio || settings.naisteraAspectRatio || '1:1';
    const preset = options.preset || settings.naisteraPreset || null;
    const body = { prompt: fullPrompt, aspect_ratio: aspectRatio };
    if (preset) body.preset = preset;
    if (referenceImages.length > 0) body.reference_images = referenceImages.slice(0, 4);
    const response = await robustFetch(url, {
        method: 'POST',
        signal: options.signal,
        headers: { 'Authorization': `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!response.ok) { const text = await response.text(); throw new Error(`API Error (${response.status}): ${text}`); }
    const result = await response.json();
    if (!result?.data_url) throw new Error('No data_url in response');
    return result.data_url;
}

// Понятный текст ошибки для тоста и подсказки на картинке ошибки.
// Сырой текст остаётся в логах.
function describeGenerationError(error) {
    if (error?.isStopped) return 'Генерация остановлена';
    const raw = String(error?.message || error || '');
    const msg = raw.toLowerCase();
    const status = Number((raw.match(/API Error \((\d{3})\)/) || [])[1] || 0);
    const has = (...list) => list.some(x => msg.includes(x));
    if (has('image_safety', 'prohibited_content', 'safety', 'content policy', 'content_policy', 'moderation', 'blockreason'))
        return 'Цензура: модель отказалась рисовать этот запрос. Попробуй переформулировать промпт.';
    if (status === 402 || has('insufficient_quota', 'billing', 'quota', 'insufficient balance', 'credits'))
        return 'Закончились деньги или квота на API. Проверь баланс у провайдера.';
    if (status === 429 || has('rate limit', 'too many requests', 'resource_exhausted'))
        return 'Лимит запросов у провайдера. Подожди немного и повтори.';
    if (status === 401 || status === 403 || has('invalid api key', 'api key not valid', 'unauthorized', 'permission'))
        return 'Неверный API ключ или нет доступа к модели.';
    if ((status === 404 && has('model')) || has('model not found', 'does not exist', 'unsupported model'))
        return 'Модель не найдена: проверь её название в настройках.';
    if (has('timed out', 'timeout'))
        return 'Таймаут: API не ответил вовремя.';
    if (has('network error', 'failed to fetch', 'networkerror'))
        return 'Нет связи с API: проверь эндпоинт и интернет.';
    if (status >= 500)
        return `Сервер API не отвечает (${status}). Попробуй позже.`;
    return raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
}

/* ── «Последний запрос»: что ушло в генерацию ── */

let lastImageRequest = null;

function markLastRequestOk(result) {
    if (lastImageRequest) lastImageRequest.status = 'ok';
    return result;
}

function rememberFinalPrompt(text) {
    if (lastImageRequest) lastImageRequest.finalPrompt = text;
}

function describeRefLabel(label) {
    if (label.startsWith('npc_face:')) return `Лицо НПС: ${label.slice(9)}`;
    if (label.startsWith('npc_outfit:')) return `Наряд НПС: ${label.slice(11)}`;
    return {
        char_face: 'Лицо персонажа',
        user_face: 'Лицо Юзера',
        char_outfit: 'Одежда персонажа',
        user_outfit: 'Одежда Юзера',
        style: 'Стиль',
        context: 'Прошлая картинка из чата',
    }[label] || 'Референс';
}

function showLastImageRequest() {
    document.querySelector('.iig-lastreq-backdrop')?.remove();
    const req = lastImageRequest;
    const statusText = !req ? '' : {
        ok: '✅ Картинка получена',
        pending: '⏳ Ещё генерируется',
        stopped: '⏹ Остановлено',
        error: `❌ Ошибка: ${req.error}`,
    }[req.status] || '';
    const refsHtml = !req ? '' : req.refs.length
        ? `<div class="iig-lastreq-refs">${req.refs.map((r, i) => `
            <figure>
                <img src="${sanitizeForHtml(r.src)}" alt="">
                <figcaption><b>${i + 1}.</b> ${sanitizeForHtml(describeRefLabel(r.label))}<small>${Math.round(r.src.length * 0.75 / 1024)} КБ</small></figcaption>
            </figure>`).join('')}</div>`
        : '<p class="iig-lastreq-muted">Картинки-референсы не отправлялись.</p>';
    const backdrop = document.createElement('div');
    backdrop.className = 'iig-lastreq-backdrop';
    backdrop.innerHTML = `<div class="iig-lastreq">
        <div class="iig-lastreq-head">
            <b><i class="fa-solid fa-magnifying-glass"></i> Последний запрос</b>
            <button class="menu_button iig-lastreq-close" title="Закрыть"><i class="fa-solid fa-xmark"></i></button>
        </div>
        ${!req ? '<p class="iig-lastreq-muted">Пока ничего не генерировалось. Сгенерируй картинку и открой снова.</p>' : `
        <div class="iig-lastreq-meta">
            <span>${new Date(req.at).toLocaleTimeString()}</span>
            <span>${sanitizeForHtml(req.apiType)}${req.model ? ' · ' + sanitizeForHtml(req.model) : ''}</span>
            <span>референсов: ${req.refs.length}${req.apiType === 'gemini' || req.apiType === 'naistera' ? ` из ${req.maxRefs} возможных` : ''}</span>
        </div>
        <div class="iig-lastreq-status">${sanitizeForHtml(statusText)}</div>
        <h4>Картинки по порядку</h4>
        ${req.refsNote ? `<p class="iig-lastreq-note">${sanitizeForHtml(req.refsNote)}</p>` : ''}
        ${refsHtml}
        <h4>Текст запроса</h4>
        <pre>${sanitizeForHtml(req.finalPrompt || req.prompt)}</pre>`}
    </div>`;
    document.documentElement.appendChild(backdrop);
    const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    backdrop.querySelector('.iig-lastreq-close').addEventListener('click', close);
}
window._iigShowLastRequest = showLastImageRequest;

function validateSettings() {
    const settings = getSettings();
    const errors = [];
    if (!settings.endpoint) errors.push('URL эндпоинта не настроен');
    if (!settings.apiKey) errors.push('API ключ не настроен');
    if (settings.apiType !== 'naistera' && !settings.model) errors.push('Модель не выбрана');
    if (errors.length > 0) throw new Error(`Ошибка настроек: ${errors.join(', ')}`);
}

function sanitizeForHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/* ── Main generation function (with wardrobe refs) ── */
async function generateImageWithRetry(prompt, style, onStatusUpdate, options = {}) {
    validateSettings();
    const settings = getSettings();
    const maxRetries = settings.maxRetries;
    const baseDelay = settings.retryDelay;

    const referenceImages = [];   // base64 — for Gemini / OpenAI
    const referenceDataUrls = []; // data URLs — for Naistera
    const refLabels = [];         // parallel labels for Gemini label system
    const urlLabels = [];         // те же подписи для Naistera — для окна «Последний запрос»
    const maxRefs = getMaxReferenceImages(settings);
    const activeStyle = getActiveStyle(settings);
    style = resolveEffectiveStyle(style, settings);

    const isGeminiType = settings.apiType === 'gemini' || isGeminiModel(settings.model);
    const isNaisteraType = settings.apiType === 'naistera';

    const getB64 = async (ref, label) => {
        if (ref?.imagePath) { const b64 = await loadRefImageAsBase64(ref.imagePath); if (b64) return b64; }
        return ref?.imageBase64 || ref?.imageData || null;
    };

    const getDataUrl = async (ref) => {
        const b64 = await getB64(ref, '');
        return b64 ? 'data:image/jpeg;base64,' + b64 : null;
    };

    const refs = getCurrentCharacterRefs();

    // Char avatar (from ST avatar folder)
    if (isNaisteraType) {
        if (settings.naisteraSendCharAvatar) {
            const d = await getCharacterAvatarDataUrl();
            if (d && referenceDataUrls.length < maxRefs) { referenceDataUrls.push(d); urlLabels.push('char_face'); }
        }
    } else {
        if (settings.sendCharAvatar) {
            const charAvatar = await getCharacterAvatarBase64();
            if (charAvatar && referenceImages.length < maxRefs) { referenceImages.push(charAvatar); refLabels.push('char_face'); }
        }
    }

    // User avatar (from ST persona)
    if (isNaisteraType) {
        if (settings.naisteraSendUserAvatar) {
            const d = await getUserAvatarDataUrl();
            if (d && referenceDataUrls.length < maxRefs) { referenceDataUrls.push(d); urlLabels.push('user_face'); }
        }
    } else {
        if (settings.sendUserAvatar) {
            const userAvatar = await getUserAvatarBase64();
            if (userAvatar && referenceImages.length < maxRefs) { referenceImages.push(userAvatar); refLabels.push('user_face'); }
        }
    }

    // Manual photo uploads (char/user slots) — override if uploaded
    if (!isNaisteraType) {
        const charB64 = await getB64(refs.charRef, 'charRef');
        if (charB64 && referenceImages.length < maxRefs) { referenceImages.push(charB64); refLabels.push('char_face'); }
        const userB64 = await getB64(refs.userRef, 'userRef');
        if (userB64 && referenceImages.length < maxRefs) { referenceImages.push(userB64); refLabels.push('user_face'); }
    } else {
        const charUrl = await getDataUrl(refs.charRef);
        if (charUrl && referenceDataUrls.length < maxRefs) { referenceDataUrls.push(charUrl); urlLabels.push('char_face'); }
        const userUrl = await getDataUrl(refs.userRef);
        if (userUrl && referenceDataUrls.length < maxRefs) { referenceDataUrls.push(userUrl); urlLabels.push('user_face'); }
    }

    // ── Wardrobe integration ──────────────────────────────────────
    if (window.sillyWardrobe?.isReady()) {
        const botB64 = window.sillyWardrobe.getActiveOutfitBase64('bot');
        const userB64 = window.sillyWardrobe.getActiveOutfitBase64('user');
        const botData = window.sillyWardrobe.getActiveOutfitData('bot');
        const userData = window.sillyWardrobe.getActiveOutfitData('user');

        let wardrobeAdded = 0;
        if (isGeminiType) {
            if (botB64 && referenceImages.length < maxRefs) { referenceImages.push(botB64); refLabels.push('char_outfit'); wardrobeAdded++; iigLog('INFO', `Wardrobe bot: "${botData?.name}"`); }
            if (userB64 && referenceImages.length < maxRefs) { referenceImages.push(userB64); refLabels.push('user_outfit'); wardrobeAdded++; iigLog('INFO', `Wardrobe user: "${userData?.name}"`); }
        } else if (isNaisteraType) {
            const botUrl = window.sillyWardrobe.getActiveOutfitDataUrl('bot');
            const userUrl = window.sillyWardrobe.getActiveOutfitDataUrl('user');
            if (botUrl && referenceDataUrls.length < maxRefs) { referenceDataUrls.push(botUrl); urlLabels.push('char_outfit'); wardrobeAdded++; }
            if (userUrl && referenceDataUrls.length < maxRefs) { referenceDataUrls.push(userUrl); urlLabels.push('user_outfit'); wardrobeAdded++; }
        } else {
            if (botB64 && referenceImages.length < maxRefs) { referenceImages.push(botB64); refLabels.push('char_outfit'); wardrobeAdded++; }
            if (userB64 && referenceImages.length < maxRefs) { referenceImages.push(userB64); refLabels.push('user_outfit'); wardrobeAdded++; }
        }
        if (wardrobeAdded > 0) iigLog('INFO', `Wardrobe: добавлено ${wardrobeAdded} аутфита(ов)`);

        // ── Inject wardrobe outfit descriptions into image prompt text ──
        const descParts = [];
        if (botData?.description) descParts.push(`[Character's current outfit: ${botData.description}]`);
        if (userData?.description) descParts.push(`[User's current outfit: ${userData.description}]`);
        if (descParts.length > 0) {
            prompt = `${descParts.join(' ')}\n${prompt}`;
            iigLog('INFO', `Wardrobe descriptions injected into prompt: ${descParts.join(', ')}`);
        }
    }

    // ── Картинка активного стиля ─────────────────────────────────
    if (activeStyle?.imagePath && (isGeminiType || isNaisteraType)) {
        const styleB64 = await loadRefImageAsBase64(activeStyle.imagePath);
        if (styleB64 && isGeminiType && referenceImages.length < maxRefs) {
            referenceImages.push(styleB64); refLabels.push('style');
            iigLog('INFO', `Style image: "${activeStyle.name}"`);
        } else if (styleB64 && isNaisteraType && referenceDataUrls.length < maxRefs) {
            referenceDataUrls.push('data:image/jpeg;base64,' + styleB64); urlLabels.push('style');
            iigLog('INFO', `Style image (naistera): "${activeStyle.name}"`);
        }
    }

    // ── Image context: предыдущие картинки из чата как рефы ──────
    if (settings.imageContextEnabled) {
        const contextCount = normalizeImageContextCount(settings.imageContextCount);
        if (isGeminiType) {
            const contextRefs = await collectPreviousContextReferences(options.messageId, 'base64', contextCount);
            for (const ref of contextRefs) {
                if (referenceImages.length < maxRefs) { referenceImages.push(ref); refLabels.push('context'); iigLog('INFO', `Image context ref added (gemini)`); }
            }
        } else if (isNaisteraType) {
            const contextRefs = await collectPreviousContextReferences(options.messageId, 'dataUrl', contextCount);
            for (const ref of contextRefs) {
                if (referenceDataUrls.length < maxRefs) { referenceDataUrls.push(ref); urlLabels.push('context'); iigLog('INFO', `Image context ref added (naistera)`); }
            }
        }
    }

    // ── NPC refs ──────────────────────────────────────────────────
    const matchedNpcs = matchNpcReferences(prompt, refs.npcReferences || []);
    const refCount = () => (isNaisteraType ? referenceDataUrls.length : referenceImages.length);
    for (const npc of matchedNpcs) {
        // Лицо НПС, затем его наряд — каждый в пределах лимита модели.
        if (refCount() < maxRefs && (npc.imagePath || npc.imageBase64)) {
            if (isNaisteraType) {
                const url = await getDataUrl(npc);
                if (url) { referenceDataUrls.push(url); urlLabels.push(`npc_face:${npc.name}`); iigLog('INFO', `NPC (naistera): ${npc.name}`); }
            } else {
                const b64 = npc.imagePath ? await loadRefImageAsBase64(npc.imagePath) : npc.imageBase64;
                if (b64) { referenceImages.push(b64); refLabels.push(`npc_face:${npc.name}`); iigLog('INFO', `NPC: ${npc.name}`); }
            }
        }
        if (refCount() < maxRefs && npc.outfit?.imagePath && (isGeminiType || isNaisteraType)) {
            const b64 = await loadRefImageAsBase64(npc.outfit.imagePath);
            if (b64 && isNaisteraType) {
                referenceDataUrls.push('data:image/jpeg;base64,' + b64); urlLabels.push(`npc_outfit:${npc.name}`);
            } else if (b64) {
                referenceImages.push(b64); refLabels.push(`npc_outfit:${npc.name}`);
            }
            if (b64) iigLog('INFO', `NPC outfit: ${npc.name} — "${npc.outfit.name}"`);
        }
    }
    const npcOutfitLines = matchedNpcs.filter(n => n.outfit?.description).map(n => `[${n.name} is wearing: ${n.outfit.description}]`);
    if (npcOutfitLines.length) prompt = `${npcOutfitLines.join(' ')}\n${prompt}`;

    iigLog('INFO', `Refs: ${referenceImages.length} base64, ${referenceDataUrls.length} dataUrls, labels=[${refLabels.join(',')}], apiType=${settings.apiType}, limit=${maxRefs}`);

    // Что реально уходит провайдеру — для окна «Последний запрос».
    let sentRefs = [];
    let refsNote = '';
    if (isNaisteraType) {
        sentRefs = referenceDataUrls.slice(0, 4).map((src, i) => ({ label: urlLabels[i] || 'reference', src }));
    } else if (isGeminiType) {
        sentRefs = referenceImages.slice(0, maxRefs).map((b64, i) => ({ label: refLabels[i] || 'reference', src: 'data:image/jpeg;base64,' + b64 }));
    } else if (settings.apiType === 'void') {
        refsNote = 'VoidAI не принимает картинки-референсы: ушёл только текст.';
    } else if (referenceImages.length) {
        sentRefs = referenceImages.slice(0, 1).map((b64, i) => ({ label: refLabels[i] || 'reference', src: 'data:image/jpeg;base64,' + b64 }));
        refsNote = 'OpenAI-режим: отправляется только первая картинка, и обычный запрос генерации её, скорее всего, не учитывает.';
    }
    lastImageRequest = {
        at: Date.now(), apiType: settings.apiType, model: settings.model || '', maxRefs,
        refs: sentRefs, refsNote, prompt, style: style || '', finalPrompt: '', status: 'pending', error: '',
    };

    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            onStatusUpdate?.(`Генерация${attempt > 0 ? ` (повтор ${attempt}/${maxRetries})` : ''}...`);
            if (settings.apiType === 'void') return markLastRequestOk(await generateImageVoid(prompt, style, options));
            if (isNaisteraType) return markLastRequestOk(await generateImageNaistera(prompt, style, { ...options, referenceImages: referenceDataUrls }));
            if (isGeminiType) return markLastRequestOk(await generateImageGemini(prompt, style, referenceImages, { ...options, refLabels }));
            return markLastRequestOk(await generateImageOpenAI(prompt, style, referenceImages, options));
        } catch (error) {
            lastError = error;
            if (error.isStopped) break;
            const isRetryable = ['429','503','502','504','timeout','network'].some(s => error.message?.includes(s));
            if (!isRetryable || attempt === maxRetries) break;
            const delay = baseDelay * Math.pow(2, attempt);
            onStatusUpdate?.(`Повтор через ${delay / 1000}с...`);
            await new Promise(resolve => {
                const timer = setTimeout(resolve, delay);
                options.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
            });
            if (options.signal?.aborted) { lastError = createStopError(); break; }
        }
    }
    if (lastImageRequest) {
        lastImageRequest.status = lastError?.isStopped ? 'stopped' : 'error';
        lastImageRequest.error = describeGenerationError(lastError);
    }
    throw lastError;
}

async function checkFileExists(path) {
    try { const r = await fetch(path, { method: 'HEAD' }); return r.ok; } catch (e) { return false; }
}

async function parseImageTags(text, options = {}) {
    const { checkExistence = false, forceAll = false } = options;
    const tags = [];

    // === NEW FORMAT ===
    const imgTagMarker = 'data-iig-instruction=';
    let searchPos = 0;
    while (true) {
        const markerPos = text.indexOf(imgTagMarker, searchPos);
        if (markerPos === -1) break;
        let imgStart = text.lastIndexOf('<img', markerPos);
        if (imgStart === -1 || markerPos - imgStart > 500) { searchPos = markerPos + 1; continue; }
        const afterMarker = markerPos + imgTagMarker.length;
        let jsonStart = text.indexOf('{', afterMarker);
        if (jsonStart === -1 || jsonStart > afterMarker + 10) { searchPos = markerPos + 1; continue; }
        let braceCount = 0, jsonEnd = -1, inString = false, escapeNext = false;
        for (let i = jsonStart; i < text.length; i++) {
            const char = text[i];
            if (escapeNext) { escapeNext = false; continue; }
            if (char === '\\' && inString) { escapeNext = true; continue; }
            if (char === '"') { inString = !inString; continue; }
            if (!inString) {
                if (char === '{') braceCount++;
                else if (char === '}') { braceCount--; if (braceCount === 0) { jsonEnd = i + 1; break; } }
            }
        }
        if (jsonEnd === -1) { searchPos = markerPos + 1; continue; }
        let imgEnd = text.indexOf('>', jsonEnd);
        if (imgEnd === -1) { searchPos = markerPos + 1; continue; }
        imgEnd++;
        const fullImgTag = text.substring(imgStart, imgEnd);
        const instructionJson = text.substring(jsonStart, jsonEnd);
        const srcMatch = fullImgTag.match(/src\s*=\s*["']?([^"'\s>]+)/i);
        const srcValue = srcMatch ? srcMatch[1] : '';
        let needsGeneration = false;
        const hasMarker = srcValue.includes('[IMG:GEN]') || srcValue.includes('[IMG:');
        const hasErrorImage = srcValue.includes('error.svg');
        const hasPath = srcValue && srcValue.startsWith('/') && srcValue.length > 5;
        if (hasErrorImage && !forceAll) { searchPos = imgEnd; continue; }
        if (forceAll) needsGeneration = true;
        else if (hasMarker || !srcValue) needsGeneration = true;
        else if (hasPath && checkExistence) {
            const exists = await checkFileExists(srcValue);
            if (!exists) needsGeneration = true;
            else { searchPos = imgEnd; continue; }
        } else if (hasPath) { searchPos = imgEnd; continue; }
        if (!needsGeneration) { searchPos = imgEnd; continue; }
        try {
            let normalizedJson = instructionJson
                .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
                .replace(/&#34;/g, '"').replace(/&amp;/g, '&');
            const data = JSON.parse(normalizedJson);
            tags.push({
                fullMatch: fullImgTag, index: imgStart,
                style: data.style || '', prompt: data.prompt || '',
                aspectRatio: data.aspect_ratio || data.aspectRatio || null,
                preset: data.preset || null,
                imageSize: data.image_size || data.imageSize || null,
                quality: data.quality || null, isNewFormat: true,
                existingSrc: hasPath ? srcValue : null
            });
        } catch (e) { iigLog('WARN', `Failed to parse instruction JSON`, e.message); }
        searchPos = imgEnd;
    }

    // === LEGACY FORMAT ===
    const marker = '[IMG:GEN:';
    let searchStart = 0;
    while (true) {
        const markerIndex = text.indexOf(marker, searchStart);
        if (markerIndex === -1) break;
        const jsonStart = markerIndex + marker.length;
        let braceCount = 0, jsonEnd = -1, inString = false, escapeNext = false;
        for (let i = jsonStart; i < text.length; i++) {
            const char = text[i];
            if (escapeNext) { escapeNext = false; continue; }
            if (char === '\\' && inString) { escapeNext = true; continue; }
            if (char === '"') { inString = !inString; continue; }
            if (!inString) {
                if (char === '{') braceCount++;
                else if (char === '}') { braceCount--; if (braceCount === 0) { jsonEnd = i + 1; break; } }
            }
        }
        if (jsonEnd === -1) { searchStart = jsonStart; continue; }
        const jsonStr = text.substring(jsonStart, jsonEnd);
        if (!text.substring(jsonEnd).startsWith(']')) { searchStart = jsonEnd; continue; }
        try {
            const data = JSON.parse(jsonStr.replace(/'/g, '"'));
            tags.push({
                fullMatch: text.substring(markerIndex, jsonEnd + 1), index: markerIndex,
                style: data.style || '', prompt: data.prompt || '',
                aspectRatio: data.aspect_ratio || data.aspectRatio || null,
                preset: data.preset || null,
                imageSize: data.image_size || data.imageSize || null,
                quality: data.quality || null, isNewFormat: false
            });
        } catch (e) { iigLog('WARN', `Failed to parse legacy tag JSON`, e.message); }
        searchStart = jsonEnd + 1;
    }
    return tags;
}

/* ── Внешние блоки (message.extra.extblocks) ── */

// Текст, который ST реально рендерит в .mes_text: с внешними блоками это
// message.extra.display_text (основной текст + блоки трекеров).
function getMessageRenderText(message, settings = getSettings()) {
    if (!message) return '';
    if (settings.externalBlocks && message.extra?.display_text) return message.extra.display_text;
    return message.mes || '';
}

// Теги из основного текста и (если включено) из внешних блоков. sourceKey
// говорит, где тег лежит, чтобы заменить его в правильном поле.
async function parseMessageImageTags(message, options = {}) {
    const settings = getSettings();
    const tags = (await parseImageTags(message?.mes || '', options)).map(tag => ({ ...tag, sourceKey: 'mes' }));
    if (settings.externalBlocks && message?.extra?.extblocks) {
        const extTags = await parseImageTags(message.extra.extblocks, options);
        tags.push(...extTags.map(tag => ({ ...tag, sourceKey: 'extblocks' })));
    }
    return tags;
}

function replaceTagInMessageSource(message, tag, replacement) {
    if (!message || !tag) return;
    if (tag.sourceKey === 'extblocks') {
        if (!message.extra) message.extra = {};
        message.extra.extblocks = (message.extra.extblocks || '').replace(tag.fullMatch, replacement);
        const swipe = message.swipe_info?.[message.swipe_id];
        if (swipe?.extra?.extblocks) swipe.extra.extblocks = swipe.extra.extblocks.replace(tag.fullMatch, replacement);
    } else {
        message.mes = (message.mes || '').replace(tag.fullMatch, replacement);
    }
    if (message.extra?.display_text) {
        message.extra.display_text = message.extra.display_text.replace(tag.fullMatch, replacement);
    }
}

function getErrorImagePath() {
    // Путь от самого модуля — не зависит от имени папки расширения.
    return new URL('./error.svg', import.meta.url).pathname;
}

const ERROR_IMAGE_PATH = getErrorImagePath();

function createLoadingPlaceholder(tagId) {
    const placeholder = document.createElement('div');
    placeholder.className = 'iig-loading-placeholder';
    placeholder.dataset.tagId = tagId;
    placeholder.innerHTML = `
        <div class="iig-spinner-wrap"><div class="iig-spinner"></div></div>
        <div class="iig-status">Генерация картинки...</div>
        <div class="iig-timer"></div>
        <div class="menu_button iig-stop-btn" title="Остановить генерацию"><i class="fa-solid fa-stop"></i> Стоп</div>
    `;
    placeholder._abortController = new AbortController();
    placeholder.querySelector('.iig-stop-btn').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        placeholder._abortController.abort();
        placeholder.querySelector('.iig-status').textContent = 'Останавливаю...';
    });
    const timerEl = placeholder.querySelector('.iig-timer');
    const startTime = Date.now();
    const tSec = FETCH_TIMEOUT / 1000;
    placeholder._timerInterval = setInterval(() => {
        const el = Math.floor((Date.now() - startTime) / 1000);
        if (el >= tSec) { timerEl.textContent = 'Таймаут...'; clearInterval(placeholder._timerInterval); return; }
        const m = Math.floor(el/60), s = el%60;
        timerEl.textContent = `${m}:${String(s).padStart(2,'0')} / ${Math.floor(tSec/60)}:00${IS_IOS ? ' (iOS)' : ''}`;
    }, 1000);
    return placeholder;
}

function createErrorPlaceholder(tagId, errorMessage, tagInfo, messageId, tagIndex) {
    const img = document.createElement('img');
    img.className = 'iig-error-image';
    img.src = ERROR_IMAGE_PATH;
    img.alt = 'Ошибка генерации';
    const friendly = describeGenerationError({ message: errorMessage });
    img.title = friendly === errorMessage ? `Ошибка: ${errorMessage}` : `${friendly}\n\n${errorMessage}`;
    img.dataset.tagId = tagId;
    if (tagInfo.fullMatch) {
        const m = tagInfo.fullMatch.match(/data-iig-instruction\s*=\s*(?:(['"])([\s\S]*?)\1)/i)
            || tagInfo.fullMatch.match(/data-iig-instruction\s*=\s*([{][\s\S]*?[}])(?:\s|>)/i);
        if (m) img.setAttribute('data-iig-instruction', m[2] || m[1]);
    }
    // Обёртка с кнопкой «повторить» — данные в dataset, клик ловит общий capture-обработчик.
    if (messageId !== undefined && tagIndex !== undefined) {
        const wrap = document.createElement('div');
        wrap.className = 'iig-img-wrap iig-error-wrap';
        wrap.dataset.tagIndex = String(tagIndex);
        const actions = document.createElement('div');
        actions.className = 'iig-img-actions';
        const btn = document.createElement('div');
        btn.className = 'iig-corner-btn iig-corner-regen';
        btn.title = 'Повторить генерацию';
        btn.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i>';
        btn.dataset.messageId = String(messageId);
        btn.dataset.tagIndex = String(tagIndex);
        actions.appendChild(btn);
        wrap.appendChild(actions);
        wrap.appendChild(img);
        return wrap;
    }
    return img;
}

async function processMessageTags(messageId) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    if (!settings.enabled) return;
    if (processingMessages.has(messageId)) return;
    const message = context.chat[messageId];
    if (!message || message.is_user) return;
    const tags = await parseMessageImageTags(message, { checkExistence: true });
    if (tags.length === 0) return;
    processingMessages.add(messageId);
    toastr.info(`Найдено тегов: ${tags.length}. Генерация...`, 'Генерация картинок', { timeOut: 3000 });
    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) { processingMessages.delete(messageId); return; }
    const mesTextEl = messageElement.querySelector('.mes_text');
    if (!mesTextEl) { processingMessages.delete(messageId); return; }

    const processTag = async (tag, index) => {
        const tagId = `iig-${messageId}-${index}`;
        const loadingPlaceholder = createLoadingPlaceholder(tagId);
        let targetElement = null;

        if (tag.isNewFormat) {
            const allImgs = mesTextEl.querySelectorAll('img[data-iig-instruction]');
            const searchPrompt = tag.prompt.substring(0, 30);
            for (const img of allImgs) {
                const instruction = img.getAttribute('data-iig-instruction');
                if (!instruction) continue;
                const decoded = instruction.replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&#39;/g,"'").replace(/&#34;/g,'"').replace(/&amp;/g,'&');
                if (decoded.includes(searchPrompt) || instruction.includes(searchPrompt)) { targetElement = img; break; }
                try {
                    const d = JSON.parse(decoded.replace(/'/g,'"'));
                    if (d.prompt?.substring(0, 30) === tag.prompt.substring(0, 30)) { targetElement = img; break; }
                } catch(e) {}
            }
            if (!targetElement) {
                for (const img of allImgs) {
                    const src = img.getAttribute('src') || '';
                    if (src.includes('[IMG:GEN]') || src === '' || src === '#') { targetElement = img; break; }
                }
            }
            if (!targetElement) {
                for (const img of mesTextEl.querySelectorAll('img')) {
                    const src = img.getAttribute('src') || '';
                    if (src.includes('[IMG:GEN]') || src.includes('[IMG:ERROR]')) { targetElement = img; break; }
                }
            }
        } else {
            const tagEscaped = tag.fullMatch.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/"/g,'(?:"|&quot;)');
            const before = mesTextEl.innerHTML;
            mesTextEl.innerHTML = mesTextEl.innerHTML.replace(new RegExp(tagEscaped,'g'), `<span data-iig-placeholder="${tagId}"></span>`);
            if (before !== mesTextEl.innerHTML) targetElement = mesTextEl.querySelector(`[data-iig-placeholder="${tagId}"]`);
            if (!targetElement) {
                for (const img of mesTextEl.querySelectorAll('img')) {
                    if (img.src && img.src.includes('[IMG:GEN:')) { targetElement = img; break; }
                }
            }
        }

        if (targetElement) {
            const parent = targetElement.parentElement;
            if (parent) {
                const ps = window.getComputedStyle(parent);
                if (ps.display === 'flex' || ps.display === 'grid') loadingPlaceholder.style.alignSelf = 'center';
            }
            targetElement.replaceWith(loadingPlaceholder);
        } else {
            mesTextEl.appendChild(loadingPlaceholder);
        }

        const statusEl = loadingPlaceholder.querySelector('.iig-status');
        try {
            const dataUrl = await generateImageWithRetry(
                tag.prompt, tag.style,
                (status) => { statusEl.textContent = status; },
                { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality, preset: tag.preset, messageId, signal: loadingPlaceholder._abortController.signal }
            );
            statusEl.textContent = 'Сохранение...';
            const imagePath = await saveImageToFile(dataUrl);
            const img = document.createElement('img');
            img.className = 'iig-generated-image';
            img.src = imagePath;
            img.alt = tag.prompt;
            img.title = `Style: ${tag.style}\nPrompt: ${tag.prompt}`;
            if (tag.isNewFormat) {
                const m = tag.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
                if (m) img.setAttribute('data-iig-instruction', m[2]);
            }
            if (loadingPlaceholder._timerInterval) clearInterval(loadingPlaceholder._timerInterval);
            loadingPlaceholder.replaceWith(img); // observer will auto-wrap
            if (tag.isNewFormat) {
                replaceTagInMessageSource(message, tag, tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${imagePath}"`));
            } else {
                replaceTagInMessageSource(message, tag, `[IMG:✓:${imagePath}]`);
            }
            sessionGenCount++;
            updateSessionStats();
            toastr.success(`Картинка ${index + 1}/${tags.length} готова`, 'Генерация картинок', { timeOut: 2000 });
        } catch (error) {
            iigLog('ERROR', `Failed tag ${index}:`, error.message);
            const errorPlaceholder = createErrorPlaceholder(tagId, error.message, tag, messageId, index);
            if (loadingPlaceholder._timerInterval) clearInterval(loadingPlaceholder._timerInterval);
            loadingPlaceholder.replaceWith(errorPlaceholder);
            if (tag.isNewFormat) {
                replaceTagInMessageSource(message, tag, tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${ERROR_IMAGE_PATH}"`));
            } else {
                replaceTagInMessageSource(message, tag, `[IMG:ERROR:${error.message.substring(0, 50)}]`);
            }
            if (error.isStopped) {
                toastr.info('Генерация остановлена', 'Генерация картинок', { timeOut: 2000 });
            } else {
                sessionErrorCount++;
                updateSessionStats();
                toastr.error(describeGenerationError(error), 'Генерация картинок');
            }
        }
    };

    try {
        await Promise.all(tags.map((tag, index) => processTag(tag, index)));
    } finally {
        processingMessages.delete(messageId);
    }
    await context.saveChat();
    if (typeof context.messageFormatting === 'function') {
        const formatted = context.messageFormatting(getMessageRenderText(message), message.name, message.is_system, message.is_user, messageId);
        mesTextEl.innerHTML = formatted;
    }
    // Observer picks up new images automatically — no manual wrapping needed
}

async function regenerateMessageImages(messageId) {
    const context = SillyTavern.getContext();
    const message = context.chat[messageId];
    if (!message) { toastr.error('Сообщение не найдено', 'Генерация картинок'); return; }
    const tags = await parseMessageImageTags(message, { forceAll: true });
    if (tags.length === 0) { toastr.warning('Нет тегов для перегенерации', 'Генерация картинок'); return; }
    toastr.info(`Перегенерация ${tags.length} картинок...`, 'Генерация картинок');
    processingMessages.add(messageId);
    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) { processingMessages.delete(messageId); return; }
    const mesTextEl = messageElement.querySelector('.mes_text');
    if (!mesTextEl) { processingMessages.delete(messageId); return; }

    for (let index = 0; index < tags.length; index++) {
        const tag = tags[index];
        const tagId = `iig-regen-${messageId}-${index}`;
        let activePlaceholder = null;
        try {
            // Prefer data-iig-instruction, but fall back to any generated image
            // (ST's messageFormatting can strip custom data-* attrs on re-render)
            let allInstructionImgs = Array.from(mesTextEl.querySelectorAll('img[data-iig-instruction]'));
            if (allInstructionImgs.length === 0) {
                allInstructionImgs = Array.from(mesTextEl.querySelectorAll(
                    'img.iig-generated-image, img[src*="/user/images/"], img[src*="iig_"], .iig-img-wrap img'
                ));
                // deduplicate (iig-img-wrap img might overlap with iig-generated-image)
                allInstructionImgs = [...new Set(allInstructionImgs)];
            }
            const existingImg = allInstructionImgs[index] || null;
            if (existingImg) {
                const instruction = existingImg.getAttribute('data-iig-instruction');
                const loadingPlaceholder = createLoadingPlaceholder(tagId);
                activePlaceholder = loadingPlaceholder;
                existingImg.replaceWith(loadingPlaceholder);
                const statusEl = loadingPlaceholder.querySelector('.iig-status');
                const dataUrl = await generateImageWithRetry(
                    tag.prompt, tag.style,
                    (status) => { statusEl.textContent = status; },
                    { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality, preset: tag.preset, messageId, signal: loadingPlaceholder._abortController.signal }
                );
                statusEl.textContent = 'Сохранение...';
                const imagePath = await saveImageToFile(dataUrl);
                const img = document.createElement('img');
                img.className = 'iig-generated-image';
                img.src = imagePath;
                img.alt = tag.prompt;
                if (instruction) img.setAttribute('data-iig-instruction', instruction);
                if (loadingPlaceholder._timerInterval) clearInterval(loadingPlaceholder._timerInterval);
                loadingPlaceholder.replaceWith(img); // observer will auto-wrap
                replaceTagInMessageSource(message, tag, tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${imagePath}"`));
                toastr.success(`Картинка ${index + 1}/${tags.length} готова`, 'Генерация картинок', { timeOut: 2000 });
            }
        } catch (error) {
            iigLog('ERROR', `Regen failed tag ${index}:`, error.message);
            if (activePlaceholder?.isConnected) {
                if (activePlaceholder._timerInterval) clearInterval(activePlaceholder._timerInterval);
                activePlaceholder.replaceWith(createErrorPlaceholder(tagId, error.message, tag, messageId, index));
            }
            if (error.isStopped) toastr.info('Генерация остановлена', 'Генерация картинок', { timeOut: 2000 });
            else toastr.error(describeGenerationError(error), 'Генерация картинок');
        }
    }
    processingMessages.delete(messageId);
    await context.saveChat();
}

/* ── Per-image corner regenerate button (haruspics style) ── */

// Оборачиваем картинку панелью действий (как в sillyimages): кнопки хранят данные
// в dataset, КЛИКИ НЕ вешаем здесь — их ловит общий capture-обработчик (см. initLightbox).
function wrapImageWithRegenBtn(img, messageId, imgIndex) {
    // Уже обёрнута → просто освежим dataset (индексы могли сдвинуться) и выходим.
    if (img.parentElement?.classList.contains('iig-img-wrap')) {
        const w = img.parentElement;
        w.dataset.tagIndex = String(imgIndex);
        const rb = w.querySelector('.iig-corner-regen');
        if (rb) { rb.dataset.messageId = String(messageId); rb.dataset.tagIndex = String(imgIndex); }
        const fb = w.querySelector('.iig-corner-fs');
        if (fb) fb.dataset.imgSrc = img.getAttribute('src') || '';
        let db = w.querySelector('.iig-corner-dl');
        if (!db) { db = makeDownloadCornerBtn(); w.querySelector('.iig-img-actions')?.prepend(db); }
        db.dataset.imgSrc = img.getAttribute('src') || '';
        return w;
    }
    const wrap = document.createElement('div');
    wrap.className = 'iig-img-wrap';
    wrap.dataset.tagIndex = String(imgIndex);

    const actions = document.createElement('div');
    actions.className = 'iig-img-actions';

    const fsBtn = document.createElement('div');
    fsBtn.className = 'iig-corner-btn iig-corner-fs';
    fsBtn.title = 'На весь экран';
    fsBtn.innerHTML = '<i class="fa-solid fa-expand"></i>';
    fsBtn.dataset.imgSrc = img.getAttribute('src') || '';

    const regenBtn = document.createElement('div');
    regenBtn.className = 'iig-corner-btn iig-corner-regen';
    regenBtn.title = 'Перегенерировать эту картинку';
    regenBtn.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i>';
    regenBtn.dataset.messageId = String(messageId);
    regenBtn.dataset.tagIndex = String(imgIndex);

    const dlBtn = makeDownloadCornerBtn();
    dlBtn.dataset.imgSrc = img.getAttribute('src') || '';

    actions.appendChild(dlBtn);
    actions.appendChild(fsBtn);
    actions.appendChild(regenBtn);

    img.parentNode.insertBefore(wrap, img);
    wrap.appendChild(actions);
    wrap.appendChild(img);
    return wrap;
}

function makeDownloadCornerBtn() {
    const btn = document.createElement('div');
    btn.className = 'iig-corner-btn iig-corner-dl';
    btn.title = 'Скачать';
    btn.innerHTML = '<i class="fa-solid fa-download"></i>';
    return btn;
}

function guessImageExtension(src, mime = '') {
    const fromMime = (mime.match(/image\/([a-z0-9+]+)/i) || [])[1];
    if (fromMime) return fromMime.replace('jpeg', 'jpg').replace('svg+xml', 'svg');
    const fromPath = (src.match(/\.([a-z0-9]+)(?:[?#]|$)/i) || [])[1];
    return fromPath ? fromPath.toLowerCase() : 'png';
}

// Скачать картинку. На iPhone/iPad Safari плохо скачивает по ссылке, поэтому там
// открывается системное меню «Поделиться», где есть «Сохранить изображение».
async function downloadGeneratedImage(src) {
    try {
        const blob = await (await fetch(src)).blob();
        const name = `image_${new Date().toISOString().replace(/[:.]/g, '-')}.${guessImageExtension(src, blob.type)}`;
        if (IS_IOS && typeof File === 'function' && navigator.canShare) {
            const file = new File([blob], name, { type: blob.type || 'image/png' });
            if (navigator.canShare({ files: [file] })) {
                try { await navigator.share({ files: [file] }); return; }
                catch (e) { if (e?.name === 'AbortError') return; /* иначе — обычное скачивание */ }
            }
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
        iigLog('ERROR', 'Image download failed:', e.message);
        toastr.error('Не получилось скачать картинку', 'Генерация картинок');
    }
}

async function regenerateSingleImage(messageId, tagIndex) {
    const context = SillyTavern.getContext();
    const message = context.chat[messageId];
    if (!message) { toastr.error('Сообщение не найдено', ''); return; }

    const tags = await parseMessageImageTags(message, { forceAll: true });
    if (tags.length === 0) { toastr.error('Тег картинки не найден в сообщении', ''); return; }
    // Индекс мог «съехать» (нестандартные картинки в сообщении) — не падаем, а берём ближайший.
    let realIndex = tagIndex;
    if (!tags[realIndex]) realIndex = Math.min(Math.max(tagIndex, 0), tags.length - 1);
    const tag = tags[realIndex];

    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) return;
    const mesTextEl = messageElement.querySelector('.mes_text');
    if (!mesTextEl) return;

    // Build deduplicated list: skip images already inside .iig-img-wrap
    // (they are represented by the wrap itself), otherwise indices double-count.
    // Also include loading/error placeholders left by previous regen attempts.
    const allTargets = [];
    for (const el of mesTextEl.querySelectorAll(
        '.iig-img-wrap, img.iig-generated-image, img[data-iig-instruction], .iig-loading-placeholder, .iig-error-placeholder'
    )) {
        if (el.tagName === 'IMG' && el.closest('.iig-img-wrap')) continue;
        if (el.classList.contains('iig-loading-placeholder') && el.closest('.iig-img-wrap')) continue;
        if (el.classList.contains('iig-error-placeholder') && el.closest('.iig-img-wrap')) continue;
        allTargets.push(el);
    }
    const targetEl = allTargets[tagIndex];
    if (!targetEl) { toastr.error('Картинка не найдена (индекс ' + tagIndex + ', всего ' + allTargets.length + ')', ''); return; }

    const tagId = `iig-single-${messageId}-${tagIndex}`;
    const lp = createLoadingPlaceholder(tagId);
    targetEl.replaceWith(lp);
    const statusEl = lp.querySelector('.iig-status');

    try {
        const dataUrl = await generateImageWithRetry(
            tag.prompt, tag.style,
            (s) => { if (statusEl) statusEl.textContent = s; },
            { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality, preset: tag.preset, messageId, signal: lp._abortController.signal }
        );
        if (statusEl) statusEl.textContent = 'Сохранение...';
        const imagePath = await saveImageToFile(dataUrl);

        const img = document.createElement('img');
        img.className = 'iig-generated-image';
        img.src = imagePath;
        img.alt = tag.prompt;
        const instrMatch = tag.fullMatch.match(/data-iig-instruction\s*=\s*(['"])[\s\S]*?\1/i);
        if (instrMatch) img.setAttribute('data-iig-instruction', instrMatch[2] || '');

        if (lp._timerInterval) clearInterval(lp._timerInterval);
        lp.replaceWith(img); // observer will auto-wrap

        replaceTagInMessageSource(message, tag, tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${imagePath}"`));
        await context.saveChat();
        toastr.success('Картинка перегенерирована', '', { timeOut: 2000 });
    } catch (err) {
        iigLog('ERROR', `Single regen failed: ${err.message}`);
        if (lp._timerInterval) clearInterval(lp._timerInterval);
        lp.replaceWith(createErrorPlaceholder(tagId, err.message, tag, messageId, tagIndex));
        if (err.isStopped) toastr.info('Генерация остановлена', '', { timeOut: 2000 });
        else toastr.error(describeGenerationError(err), '');
    }

}


function addRegenerateButton(messageElement, messageId) {
    if (messageElement.querySelector('.iig-regenerate-btn')) return;
    const extraMesButtons = messageElement.querySelector('.extraMesButtons');
    if (!extraMesButtons) return;
    const btn = document.createElement('div');
    btn.className = 'mes_button iig-regenerate-btn fa-solid fa-images interactable';
    btn.title = 'Перегенерировать картинки';
    btn.tabIndex = 0;
    btn.addEventListener('click', async (e) => { e.stopPropagation(); await regenerateMessageImages(messageId); });
    extraMesButtons.appendChild(btn);
}

function addButtonsToExistingMessages() {
    const context = SillyTavern.getContext();
    if (!context.chat || context.chat.length === 0) return;
    for (const messageElement of document.querySelectorAll('#chat .mes')) {
        const mesId = messageElement.getAttribute('mesid');
        if (mesId === null) continue;
        const messageId = parseInt(mesId, 10);
        const message = context.chat[messageId];
        if (!message || message.is_user) continue;
        addRegenerateButton(messageElement, messageId);
    }
    // Observer handles image wrapping — trigger a flush pass
    document.getElementById('chat')?.dispatchEvent(new Event('iig-flush'));
}

async function onMessageReceived(messageId) {
    const settings = getSettings();
    if (!settings.enabled) return;
    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) return;
    addRegenerateButton(messageElement, messageId);
    await processMessageTags(messageId);
}

/* ══════════════════════════════════════════════════════════
   SETTINGS UI
   ══════════════════════════════════════════════════════════ */

function renderRefSlots() {
    const settings = getCurrentCharacterRefs();
    const setThumb = (thumb, ref) => {
        if (!thumb) return;
        if (ref?.imagePath) thumb.src = ref.imagePath;
        else if (ref?.imageBase64) thumb.src = 'data:image/jpeg;base64,' + ref.imageBase64;
        else thumb.src = '';
    };
    renderNpcList();
}

// Dynamic NPC list — multiple NPCs with enable/disable checkbox
function renderNpcList() {
    const settings = getCurrentCharacterRefs();
    const container = document.getElementById('iig_npc_list');
    if (!container) return;

    container.innerHTML = '';

    if (!settings.npcReferences || settings.npcReferences.length === 0) {
        container.innerHTML = '<p style="color:#5a5252;font-size:11px;margin:4px 0;">Нет добавленных NPC</p>';
        return;
    }

    for (let i = 0; i < settings.npcReferences.length; i++) {
        const npc = settings.npcReferences[i];

        const slot = document.createElement('div');
        slot.className = 'iig-ref-slot iig-npc-slot';

        // Checkbox включить/выключить
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = npc.enabled !== false;
        checkbox.title = 'Включить/выключить NPC референс';
        checkbox.addEventListener('change', (e) => {
            settings.npcReferences[i].enabled = e.target.checked;
            saveSettings();
            // Sync open panel
            if (typeof window._vwSyncFromSettings === 'function') window._vwSyncFromSettings();
        });

        const label = document.createElement('div');
        label.className = 'iig-ref-label';
        label.textContent = `NPC ${i + 1}`;

        const preview = document.createElement('div');
        preview.className = 'iig-ref-preview';
        const thumb = document.createElement('img');
        thumb.className = 'iig-ref-thumb';
        thumb.alt = npc.name || `NPC ${i + 1}`;
        if (npc.imageBase64 || npc.imageData) {
            thumb.src = 'data:image/jpeg;base64,' + (npc.imageBase64 || npc.imageData);
        } else if (npc.imagePath) {
            thumb.src = npc.imagePath;
        } else {
            thumb.src = '';
        }
        preview.appendChild(thumb);

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.className = 'text_pole iig-ref-name';
        nameInput.placeholder = 'Имя NPC';
        nameInput.value = npc.name || '';
        nameInput.addEventListener('input', (e) => {
            settings.npcReferences[i].name = e.target.value;
            saveSettings();
        });

        const uploadLabel = document.createElement('label');
        uploadLabel.className = 'menu_button iig-ref-upload-btn';
        uploadLabel.title = 'Загрузить фото';
        uploadLabel.innerHTML = '<i class="fa-solid fa-upload"></i>';

        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*';
        fileInput.style.display = 'none';
        fileInput.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
                const rawBase64 = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result.split(',')[1]);
                    reader.onerror = reject;
                    reader.readAsDataURL(file);
                });
                const compressed = await compressBase64Image(rawBase64, 768, 0.8);
                settings.npcReferences[i].imageBase64 = compressed;
                settings.npcReferences[i].imagePath = '';
                saveSettings();
                thumb.src = 'data:image/jpeg;base64,' + compressed;
                toastr.success(`Фото для "${settings.npcReferences[i].name || `NPC ${i+1}`}" загружено`, 'Генерация картинок', { timeOut: 2000 });
            } catch (err) {
                iigLog('ERROR', `NPC ${i} upload failed:`, err.message);
                toastr.error('Ошибка загрузки фото', 'Генерация картинок');
            }
            e.target.value = '';
        });
        uploadLabel.appendChild(fileInput);

        const deleteBtn = document.createElement('div');
        deleteBtn.className = 'menu_button iig-ref-delete-btn';
        deleteBtn.title = 'Удалить NPC';
        deleteBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
        deleteBtn.style.color = '#cc5555';
        deleteBtn.addEventListener('click', () => {
            const name = settings.npcReferences[i]?.name || `NPC ${i + 1}`;
            settings.npcReferences.splice(i, 1);
            saveSettings();
            renderNpcList();
            toastr.info(`NPC "${name}" удалён`, 'Генерация картинок', { timeOut: 2000 });
        });

        slot.appendChild(checkbox);
        slot.appendChild(label);
        slot.appendChild(preview);
        slot.appendChild(nameInput);
        slot.appendChild(uploadLabel);
        slot.appendChild(deleteBtn);
        container.appendChild(slot);
    }
}

function bindNpcSlotEvent() {
    // Add NPC button
    document.getElementById('iig_npc_add')?.addEventListener('click', () => {
        const nameInput = document.getElementById('iig_npc_new_name');
        const name = nameInput?.value?.trim();
        if (!name) {
            toastr.warning('Введите имя NPC', 'Генерация картинок');
            return;
        }
        const s = getCurrentCharacterRefs();
        if (s.npcReferences.some(n => n.name.toLowerCase() === name.toLowerCase())) {
            toastr.warning(`NPC "${name}" уже существует`, 'Генерация картинок');
            return;
        }
        s.npcReferences.push({ name, imageBase64: '', imagePath: '', enabled: true });
        saveSettings();
        if (nameInput) nameInput.value = '';
        renderNpcList();
        toastr.success(`NPC "${name}" добавлен — загрузите фото!`, 'Генерация картинок', { timeOut: 3000 });
    });

    document.getElementById('iig_npc_new_name')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            document.getElementById('iig_npc_add')?.click();
        }
    });

    renderNpcList();
}

function renderUserAvatarDropdown(avatars = []) {
    const settings = getSettings();
    const list = document.getElementById('iig_user_avatar_dropdown_list');
    if (!list) return;
    list.innerHTML = '';

    const emptyItem = document.createElement('div');
    emptyItem.className = `iig-avatar-dropdown-item iig-no-avatar ${!settings.userAvatarFile ? 'selected' : ''}`;
    emptyItem.dataset.value = '';
    emptyItem.innerHTML = `
        <div style="width:36px;height:36px;border-radius:5px;background:rgba(255,255,255,0.03);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
            <i class="fa-solid fa-wand-magic-sparkles" style="color:#5a5252;font-size:12px;"></i>
        </div>
        <span class="iig-item-name">-- Авто (из персоны) --</span>
    `;
    emptyItem.addEventListener('click', () => selectUserAvatar('', null));
    list.appendChild(emptyItem);

    for (const avatarFile of avatars) {
        const item = document.createElement('div');
        item.className = `iig-avatar-dropdown-item ${settings.userAvatarFile === avatarFile ? 'selected' : ''}`;
        item.dataset.value = avatarFile;
        const thumb = document.createElement('img');
        thumb.className = 'iig-item-thumb';
        thumb.src = `/User Avatars/${encodeURIComponent(avatarFile)}`;
        thumb.alt = avatarFile;
        thumb.loading = 'lazy';
        thumb.onerror = function() { this.style.display = 'none'; };
        const name = document.createElement('span');
        name.className = 'iig-item-name';
        name.textContent = avatarFile;
        item.appendChild(thumb);
        item.appendChild(name);
        item.addEventListener('click', () => selectUserAvatar(avatarFile, thumb.src));
        list.appendChild(item);
    }
}

async function loadAndRenderUserAvatars() {
    try {
        const avatars = await fetchUserAvatars();
        renderUserAvatarDropdown(avatars);
    } catch (e) {
        iigLog('ERROR', 'loadAndRenderUserAvatars:', e.message);
        toastr.error('Ошибка загрузки аватаров', 'Генерация картинок');
    }
}

async function selectUserAvatar(avatarFile, thumbSrc) {
    const settings = getSettings();
    settings.userAvatarFile = avatarFile;
    saveSettings();

    const selected = document.getElementById('iig_user_avatar_dropdown_selected');
    if (selected) {
        if (avatarFile) {
            selected.innerHTML = `
                <img class="iig-dropdown-thumb" src="/User Avatars/${encodeURIComponent(avatarFile)}" alt="" onerror="this.style.display='none'">
                <span class="iig-dropdown-text">${avatarFile}</span>
                <span class="iig-dropdown-arrow fa-solid fa-chevron-down"></span>
            `;
        } else {
            selected.innerHTML = `
                <div class="iig-dropdown-placeholder"><i class="fa-solid fa-user"></i></div>
                <span class="iig-dropdown-text">-- Авто (из персоны) --</span>
                <span class="iig-dropdown-arrow fa-solid fa-chevron-down"></span>
            `;
        }
    }

    const list = document.getElementById('iig_user_avatar_dropdown_list');
    if (list) {
        list.querySelectorAll('.iig-avatar-dropdown-item').forEach(item => {
            item.classList.toggle('selected', item.dataset.value === avatarFile);
        });
    }

    const dropdown = document.getElementById('iig_user_avatar_dropdown');
    if (dropdown) dropdown.classList.remove('open');
}

function createSettingsUI() {
    const settings = getSettings();
    const container = document.getElementById('extensions_settings');
    if (!container) return;

    const html = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Chamber of Secrets</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="iig-settings">

                    <!-- Enable/Disable -->
                    <label class="checkbox_label" style="margin-top:4px;">
                        <input type="checkbox" id="iig_enabled" ${settings.enabled ? 'checked' : ''}>
                        <span>Включить генерацию картинок</span>
                    </label>
                    <label class="checkbox_label" title="Искать теги картинок и во внешних блоках сообщения (message.extra.extblocks), которые добавляют расширения-трекеры">
                        <input type="checkbox" id="iig_external_blocks" ${settings.externalBlocks ? 'checked' : ''}>
                        <span>Обрабатывать внешние блоки</span>
                    </label>

                    <hr>

                    <!-- API Configuration -->
                    <div class="iig-section">
                        <h4><i class="fa-solid fa-plug"></i> Настройки API</h4>
                        <div class="iig-profile-bar">
                            <label for="iig_profile_select">Профиль подключения</label>
                            <div class="iig-profile-controls">
                                <select id="iig_profile_select" class="text_pole"></select>
                                <div id="iig_profile_add" class="menu_button" title="Новый профиль (копия текущего)"><i class="fa-solid fa-plus"></i></div>
                                <div id="iig_profile_rename" class="menu_button" title="Переименовать профиль"><i class="fa-solid fa-pen"></i></div>
                                <div id="iig_profile_remove" class="menu_button" title="Удалить профиль"><i class="fa-solid fa-trash"></i></div>
                            </div>
                        </div>
                        <p class="hint">Профиль хранит тип API, эндпоинт, ключ, модель и параметры генерации. Изменения сохраняются в активный профиль сами.</p>
                        <div class="flex-row">
                            <label for="iig_api_type">Тип API</label>
                            <select id="iig_api_type" class="flex1">
                                <option value="openai" ${settings.apiType === 'openai' ? 'selected' : ''}>OpenAI-совместимый</option>
                                <option value="void" ${settings.apiType === 'void' ? 'selected' : ''}>VoidAI</option>
                                <option value="gemini" ${settings.apiType === 'gemini' ? 'selected' : ''}>Gemini / Nano-Banana</option>
                                <option value="naistera" ${settings.apiType === 'naistera' ? 'selected' : ''}>Naistera / Grok</option>
                            </select>
                        </div>
                        <div class="flex-row">
                            <label for="iig_endpoint">Эндпоинт</label>
                            <input type="text" id="iig_endpoint" class="text_pole flex1"
                                   value="${sanitizeForHtml(settings.endpoint)}"
                                   placeholder="https://api.example.com">
                        </div>
                        <div class="flex-row" style="gap:4px;flex-wrap:wrap;">
                            <span style="font-size:0.8em;opacity:0.6;align-self:center;">Быстрый выбор:</span>
                            <div class="menu_button iig-preset-btn" data-preset-url="https://api.voidai.app" data-preset-type="void" style="font-size:0.8em;padding:2px 8px;">VoidAI</div>
                            <div class="menu_button iig-preset-btn" data-preset-url="https://api.routemyai.com" data-preset-type="openai" style="font-size:0.8em;padding:2px 8px;">RouteMyAI</div>
                            <div class="menu_button iig-preset-btn" data-preset-url="https://api.openai.com" data-preset-type="openai" style="font-size:0.8em;padding:2px 8px;">OpenAI</div>
                        </div>
                        <div class="flex-row">
                            <label for="iig_api_key">API ключ</label>
                            <input type="password" id="iig_api_key" class="text_pole flex1"
                                   value="${sanitizeForHtml(settings.apiKey)}">
                            <div id="iig_key_toggle" class="menu_button iig-key-toggle" title="Показать/Скрыть">
                                <i class="fa-solid fa-eye"></i>
                            </div>
                        </div>
                        <p id="iig_naistera_hint" class="hint ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}">Токен из Telegram бота. Модель не требуется.</p>
                        <div class="flex-row ${settings.apiType === 'naistera' ? 'iig-hidden' : ''}" id="iig_model_row">
                            <label for="iig_model">Модель</label>
                            <select id="iig_model" class="flex1">
                                ${settings.model ? `<option value="${sanitizeForHtml(settings.model)}" selected>${sanitizeForHtml(settings.model)}</option>` : '<option value="">-- Выберите модель --</option>'}
                            </select>
                            <div id="iig_refresh_models" class="menu_button iig-refresh-btn" title="Обновить список">
                                <i class="fa-solid fa-sync"></i>
                            </div>
                        </div>
                        <div id="iig_test_connection" class="menu_button iig-test-connection">
                            <i class="fa-solid fa-wifi"></i> Тест соединения
                        </div>
                    </div>

                    <hr>

                    <!-- Image Context Section -->
                    <div class="iig-section ${['naistera', 'gemini'].includes(settings.apiType) ? '' : 'iig-hidden'}" id="iig_image_context_section">
                        <h4><i class="fa-solid fa-clock-rotate-left"></i> Контекст картинок</h4>
                        <label class="checkbox_label">
                            <input type="checkbox" id="iig_image_context_enabled" ${settings.imageContextEnabled ? 'checked' : ''}>
                            <span>Включить контекст картинок</span>
                        </label>
                        <div class="flex-row ${settings.imageContextEnabled ? '' : 'iig-hidden'}" id="iig_image_context_count_row" style="margin-top:6px;align-items:center;gap:6px;">
                            <span style="white-space:nowrap;">Использовать</span>
                            <input type="number" id="iig_image_context_count" class="text_pole"
                                style="width:54px;" min="1" max="${MAX_CONTEXT_IMAGES}" step="1"
                                value="${normalizeImageContextCount(settings.imageContextCount)}">
                            <span style="white-space:nowrap;">предыд. картинок (макс. ${MAX_CONTEXT_IMAGES})</span>
                        </div>
                    </div>

                    <hr>

                    <!-- Generation Settings -->
                    <div class="iig-section">
                        <h4><i class="fa-solid fa-sliders"></i> Параметры генерации</h4>
                        <div class="flex-row" id="iig_size_row">
                            <label for="iig_size">Размер</label>
                            <select id="iig_size" class="flex1">
                                <option value="1024x1024" ${settings.size === '1024x1024' ? 'selected' : ''}>1024×1024 (Квадрат)</option>
                                <option value="1536x1024" ${settings.size === '1536x1024' ? 'selected' : ''}>1536×1024 (Альбом)</option>
                                <option value="1024x1536" ${settings.size === '1024x1536' ? 'selected' : ''}>1024×1536 (Портрет)</option>
                                <option value="2048x2048" ${settings.size === '2048x2048' ? 'selected' : ''}>2048×2048 (Large)</option>
                                <option value="512x512" ${settings.size === '512x512' ? 'selected' : ''}>512×512 (Маленький)</option>
                                <option value="auto" ${settings.size === 'auto' ? 'selected' : ''}>Авто</option>
                            </select>
                        </div>
                        <div class="flex-row" id="iig_quality_row">
                            <label for="iig_quality">Качество</label>
                            <select id="iig_quality" class="flex1">
                                <option value="standard" ${settings.quality === 'standard' ? 'selected' : ''}>Стандартное</option>
                                <option value="hd" ${settings.quality === 'hd' ? 'selected' : ''}>HD</option>
                            </select>
                        </div>
                        <div class="flex-row ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}" id="iig_naistera_aspect_row">
                            <label for="iig_naistera_aspect_ratio">Соотношение сторон</label>
                            <select id="iig_naistera_aspect_ratio" class="flex1">
                                <option value="1:1" ${settings.naisteraAspectRatio === '1:1' ? 'selected' : ''}>1:1</option>
                                <option value="3:2" ${settings.naisteraAspectRatio === '3:2' ? 'selected' : ''}>3:2</option>
                                <option value="2:3" ${settings.naisteraAspectRatio === '2:3' ? 'selected' : ''}>2:3</option>
                            </select>
                        </div>
                        <div class="flex-row ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}" id="iig_naistera_preset_row">
                            <label for="iig_naistera_preset">Пресет</label>
                            <select id="iig_naistera_preset" class="flex1">
                                <option value="" ${!settings.naisteraPreset ? 'selected' : ''}>Без пресета</option>
                                <option value="digital" ${settings.naisteraPreset === 'digital' ? 'selected' : ''}>Digital</option>
                                <option value="realism" ${settings.naisteraPreset === 'realism' ? 'selected' : ''}>Realism</option>
                            </select>
                        </div>
                        <div id="iig_gemini_params" class="${settings.apiType !== 'gemini' ? 'iig-hidden' : ''}">
                            <div class="flex-row">
                                <label for="iig_aspect_ratio">Соотношение сторон</label>
                                <select id="iig_aspect_ratio" class="flex1">
                                    <option value="1:1" ${settings.aspectRatio === '1:1' ? 'selected' : ''}>1:1 (Квадрат)</option>
                                    <option value="2:3" ${settings.aspectRatio === '2:3' ? 'selected' : ''}>2:3 (Портрет)</option>
                                    <option value="3:2" ${settings.aspectRatio === '3:2' ? 'selected' : ''}>3:2 (Альбом)</option>
                                    <option value="9:16" ${settings.aspectRatio === '9:16' ? 'selected' : ''}>9:16 (Вертикаль)</option>
                                    <option value="16:9" ${settings.aspectRatio === '16:9' ? 'selected' : ''}>16:9 (Широкий)</option>
                                    <option value="4:3" ${settings.aspectRatio === '4:3' ? 'selected' : ''}>4:3</option>
                                    <option value="3:4" ${settings.aspectRatio === '3:4' ? 'selected' : ''}>3:4</option>
                                    <option value="4:5" ${settings.aspectRatio === '4:5' ? 'selected' : ''}>4:5</option>
                                    <option value="5:4" ${settings.aspectRatio === '5:4' ? 'selected' : ''}>5:4</option>
                                    <option value="21:9" ${settings.aspectRatio === '21:9' ? 'selected' : ''}>21:9 (Ультраширокий)</option>
                                </select>
                            </div>
                            <div class="flex-row">
                                <label for="iig_image_size">Разрешение</label>
                                <select id="iig_image_size" class="flex1">
                                    <option value="1K" ${settings.imageSize === '1K' ? 'selected' : ''}>1K (по умолчанию)</option>
                                    <option value="2K" ${settings.imageSize === '2K' ? 'selected' : ''}>2K</option>
                                    <option value="4K" ${settings.imageSize === '4K' ? 'selected' : ''}>4K</option>
                                </select>
                            </div>
                        </div>
                    </div>

                    <hr>

                    <!-- Styles Section -->
                    <div class="iig-section" id="iig_styles_section">
                        <h4><i class="fa-solid fa-palette"></i> Стили</h4>
                        <div class="iig-style-workspace">
                            <div class="iig-settings-group iig-style-library">
                                <div class="iig-settings-group-title iig-style-library-head">
                                    <i class="fa-solid fa-swatchbook"></i>
                                    <span>Библиотека стилей</span>
                                    <button type="button" id="iig_style_add" class="menu_button iig-button-inline"><i class="fa-solid fa-plus"></i><span>Новый стиль</span></button>
                                </div>
                                <div id="iig_style_presets"></div>
                            </div>
                            <div class="iig-settings-group iig-style-editor-group">
                                <div class="iig-settings-group-title"><i class="fa-solid fa-pen-to-square"></i><span>Редактор</span></div>
                                <div id="iig_style_editor"></div>
                            </div>
                        </div>
                        <p class="hint">Активный стиль заменяет style из тега. Картинка стиля уходит референсом в Gemini и Naistera.</p>
                    </div>

                    <hr>

                    <!-- References Section -->
                    <div id="iig_refs_section" class="iig-refs">
                        <h4><i class="fa-solid fa-user-group"></i> Референсы персонажей</h4>

                        <!-- Char avatar toggle -->
                        <div style="margin-bottom:6px;">
                            <label class="checkbox_label">
                                <input type="checkbox" id="iig_send_char_avatar" ${settings.sendCharAvatar ? 'checked' : ''}>
                                <span>Отправлять аватар {{char}}</span>
                            </label>
                        </div>

                        <!-- Char manual photo (collapsible) -->
                        <div style="margin-bottom:10px;">
                            <div id="iig_char_photo_toggle" class="menu_button" style="width:100%;text-align:left;font-size:0.85em;padding:4px 8px;">
                                <i class="fa-solid fa-chevron-${settings.charPhotoOpen ? 'down' : 'right'}"></i>
                                <i class="fa-solid fa-robot" style="margin-left:4px;"></i> Фото {{char}} вручную
                                ${settings.charRef?.imagePath || settings.charRef?.imageBase64 ? '<i class="fa-solid fa-circle" style="color:#7cb87c;font-size:8px;margin-left:4px;" title="Загружено"></i>' : ''}
                            </div>
                            <div id="iig_char_photo_section" class="${settings.charPhotoOpen ? '' : 'iig-hidden'}" style="margin-top:4px;padding:6px;background:rgba(0,0,0,0.15);border-radius:4px;">
                                <div class="iig-ref-slot" data-ref-type="char" style="display:flex;gap:6px;align-items:center;">
                                    <img class="iig-ref-thumb" src="${settings.charRef?.imagePath || (settings.charRef?.imageBase64 ? 'data:image/jpeg;base64,'+settings.charRef.imageBase64 : '')}" style="width:48px;height:48px;object-fit:cover;border-radius:4px;background:#333;" onerror="this.src=''">
                                    <label class="menu_button iig-ref-upload-btn" title="Загрузить фото">
                                        <i class="fa-solid fa-upload"></i>
                                        <input type="file" class="iig-ref-file-input" accept="image/*" style="display:none;">
                                    </label>
                                    <div class="menu_button iig-ref-delete-btn" style="color:#cc5555;" title="Очистить"><i class="fa-solid fa-trash"></i></div>
                                </div>
                                <p style="font-size:10px;color:#888;margin:4px 0 0;">Если загружено — заменяет аватар {{char}} из чекбокса выше</p>
                            </div>
                        </div>

                        <!-- User avatar toggle -->
                        <div style="margin-bottom:6px;">
                            <label class="checkbox_label">
                                <input type="checkbox" id="iig_send_user_avatar" ${settings.sendUserAvatar ? 'checked' : ''}>
                                <span>Отправлять аватар {{user}}</span>
                            </label>
                        </div>

                        <!-- User avatar manual selection (dropdown from ST) -->
                        <div id="iig_user_avatar_manual_section" class="${!settings.sendUserAvatar ? 'iig-hidden' : ''}" style="margin-bottom:6px;">
                            <h5 style="margin:0 0 4px;font-size:0.9em;"><i class="fa-solid fa-user"></i> Аватар {{user}} (из персоны ST)</h5>
                            <div class="flex-row" style="gap:4px;align-items:center;">
                                <div id="iig_user_avatar_dropdown" class="iig-avatar-dropdown">
                                    <div id="iig_user_avatar_dropdown_selected" class="iig-avatar-dropdown-selected">
                                        ${settings.userAvatarFile
                                            ? `<img class="iig-dropdown-thumb" src="/User Avatars/${encodeURIComponent(settings.userAvatarFile)}" alt="" onerror="this.style.display='none'">`
                                            : '<div class="iig-dropdown-placeholder"><i class="fa-solid fa-user"></i></div>'}
                                        <span class="iig-dropdown-text">${settings.userAvatarFile || '-- Авто (из персоны) --'}</span>
                                        <span class="iig-dropdown-arrow fa-solid fa-chevron-down"></span>
                                    </div>
                                    <div id="iig_user_avatar_dropdown_list" class="iig-avatar-dropdown-list"></div>
                                </div>
                                <div id="iig_user_avatar_refresh" class="menu_button iig-refresh-btn" title="Обновить список">
                                    <i class="fa-solid fa-sync"></i>
                                </div>
                            </div>
                        </div>

                        <!-- User manual photo (collapsible) -->
                        <div style="margin-bottom:10px;">
                            <div id="iig_user_photo_toggle" class="menu_button" style="width:100%;text-align:left;font-size:0.85em;padding:4px 8px;">
                                <i class="fa-solid fa-chevron-${settings.userPhotoOpen ? 'down' : 'right'}"></i>
                                <i class="fa-solid fa-user" style="margin-left:4px;"></i> Фото {{user}} вручную
                                ${settings.userRef?.imagePath || settings.userRef?.imageBase64 ? '<i class="fa-solid fa-circle" style="color:#7cb87c;font-size:8px;margin-left:4px;" title="Загружено"></i>' : ''}
                            </div>
                            <div id="iig_user_photo_section" class="${settings.userPhotoOpen ? '' : 'iig-hidden'}" style="margin-top:4px;padding:6px;background:rgba(0,0,0,0.15);border-radius:4px;">
                                <div class="iig-ref-slot" data-ref-type="user" style="display:flex;gap:6px;align-items:center;">
                                    <img class="iig-ref-thumb" src="${settings.userRef?.imagePath || (settings.userRef?.imageBase64 ? 'data:image/jpeg;base64,'+settings.userRef.imageBase64 : '')}" style="width:48px;height:48px;object-fit:cover;border-radius:4px;background:#333;" onerror="this.src=''">
                                    <label class="menu_button iig-ref-upload-btn" title="Загрузить фото">
                                        <i class="fa-solid fa-upload"></i>
                                        <input type="file" class="iig-ref-file-input" accept="image/*" style="display:none;">
                                    </label>
                                    <div class="menu_button iig-ref-delete-btn" style="color:#cc5555;" title="Очистить"><i class="fa-solid fa-trash"></i></div>
                                </div>
                                <p style="font-size:10px;color:#888;margin:4px 0 0;">Если загружено — заменяет аватар {{user}} из чекбокса выше</p>
                            </div>
                        </div>

                        <hr>
                        <!-- NPC list -->
                        <h5 style="margin:6px 0 4px;"><i class="fa-solid fa-users"></i> НПС</h5>
                        <div id="iig_npc_list"></div>
                        <div class="flex-row" style="margin-top:8px;gap:4px;">
                            <input type="text" id="iig_npc_new_name" class="text_pole flex1" placeholder="Имя НПС (напр. Люка)">
                            <div id="iig_npc_add" class="menu_button" title="Добавить НПС">
                                <i class="fa-solid fa-plus"></i> Добавить
                            </div>
                        </div>

                        <div class="iig-ref-instruction">
                            <h5><i class="fa-solid fa-terminal"></i> Инструкция перед референсами</h5>
                            <p class="hint">Добавляется в начало промпта, когда в генерацию уходят картинки-референсы (Gemini, Naistera). Помогает модели точно копировать внешность.</p>
                            <label class="checkbox_label">
                                <input type="checkbox" id="iig_ref_instruction_enabled" ${settings.refInstructionEnabled !== false ? 'checked' : ''}>
                                <span>Отправлять инструкцию</span>
                            </label>
                            <textarea id="iig_ref_instruction" class="text_pole" rows="4" ${settings.refInstructionEnabled === false ? 'disabled' : ''}>${sanitizeForHtml(String(settings.refInstruction || '').trim() || DEFAULT_REF_INSTRUCTION)}</textarea>
                            <div id="iig_ref_instruction_reset" class="menu_button"><i class="fa-solid fa-rotate-left"></i> Вернуть стандартный текст</div>
                        </div>
                    </div>

                    <hr>

                    <!-- Wardrobe Section -->
                    <div class="iig-section iig-wardrobe-section">
                        <h4><i class="fa-solid fa-shirt"></i> Гардероб</h4>
                        <div class="iig-hint" style="opacity:0.6;font-size:0.8em;margin:-4px 0 8px;">
                            Гардероб, НПС и теги — в панели по кнопке у поля ввода.
                        </div>
                        <div class="iig-section" style="margin-top:10px;padding:10px;">
                            <div class="flex-row">
                                <label for="sw_max_dim">Макс. размер фото (px)</label>
                                <input type="number" id="sw_max_dim" class="text_pole flex1"
                                       value="512" min="128" max="1024" step="64">
                            </div>
                            <div class="flex-row" style="margin-top:6px;">
                                <label>Очистить все аутфиты</label>
                                <div id="sw_clear_all" class="menu_button" style="color:#cc5555;">
                                    <i class="fa-solid fa-trash"></i> Очистить
                                </div>
                            </div>
                        </div>
                        <!-- Vision для авто-описания -->
                        <div class="iig-section" style="margin-top:10px;padding:10px;">
                            <h5 style="margin:0 0 6px;"><i class="fa-solid fa-eye"></i> Vision для авто-описания</h5>
                            <div class="flex-row">
                                <label for="sw_vision_endpoint" style="min-width:80px;">Endpoint</label>
                                <input type="text" id="sw_vision_endpoint" class="text_pole flex1"
                                       placeholder="https://api.openai.com">
                            </div>
                            <div class="flex-row" style="margin-top:4px;">
                                <label for="sw_vision_apikey" style="min-width:80px;">API Key</label>
                                <input type="password" id="sw_vision_apikey" class="text_pole flex1" placeholder="sk-...">
                                <div id="sw_vision_key_toggle" class="menu_button" style="padding:4px 8px;" title="Показать/скрыть">
                                    <i class="fa-solid fa-eye"></i>
                                </div>
                            </div>
                            <div class="flex-row" style="margin-top:4px;">
                                <label for="sw_vision_model" style="min-width:80px;">Модель</label>
                                <input type="text" id="sw_vision_model" class="text_pole flex1" placeholder="gpt-4o">
                            </div>
                            <div id="sw_vision_test" class="menu_button" style="margin-top:8px;width:100%;text-align:center;">
                                <i class="fa-solid fa-vial"></i> Тест Vision
                            </div>
                        </div>
                    </div>

                    <hr>

                    <!-- Retry Settings -->
                    <div class="iig-section">
                        <h4><i class="fa-solid fa-rotate"></i> Настройки повтора</h4>
                        <div class="flex-row">
                            <label for="iig_max_retries">Макс. повторов</label>
                            <input type="number" id="iig_max_retries" class="text_pole flex1"
                                   value="${settings.maxRetries}" min="0" max="5">
                        </div>
                        <div class="flex-row">
                            <label for="iig_retry_delay">Задержка (мс)</label>
                            <input type="number" id="iig_retry_delay" class="text_pole flex1"
                                   value="${settings.retryDelay}" min="500" max="10000" step="500">
                        </div>
                    </div>

                    <hr>

                    <!-- Debug -->
                    <div class="iig-section">
                        <h4><i class="fa-solid fa-bug"></i> Отладка</h4>
                        <div id="iig_show_last_request" class="menu_button iig-export-logs-btn">
                            <i class="fa-solid fa-magnifying-glass"></i> Последний запрос
                        </div>
                        <div id="iig_export_logs" class="menu_button iig-export-logs-btn">
                            <i class="fa-solid fa-download"></i> Экспорт логов
                        </div>
                    </div>

                </div>
            </div>
        </div>
    `;

    container.insertAdjacentHTML('beforeend', html);
    bindSettingsEvents();
    renderRefSlots();

    // Init wardrobe settings fields from saved settings
    const swSettings = SillyTavern.getContext().extensionSettings['silly_wardrobe'];
    if (swSettings) {
        const dimInput = document.getElementById('sw_max_dim');
        if (dimInput && swSettings.maxDimension) dimInput.value = swSettings.maxDimension;

        const epInput = document.getElementById('sw_vision_endpoint');
        if (epInput && swSettings.visionEndpoint) epInput.value = swSettings.visionEndpoint;

        const keyInput = document.getElementById('sw_vision_apikey');
        if (keyInput && swSettings.visionApiKey) keyInput.value = swSettings.visionApiKey;

        const modelInput = document.getElementById('sw_vision_model');
        if (modelInput && swSettings.visionModel) modelInput.value = swSettings.visionModel;
    }

    // Refresh wardrobe display
    if (window.sillyWardrobe?.refreshDisplay) {
        setTimeout(() => window.sillyWardrobe.refreshDisplay(), 300);
    }
}

// Какой стиль открыт в редакторе (не обязательно активный) и строка поиска.
let selectedStyleId = '';
let styleSearchQuery = '';

function getSelectedStyle(settings = getSettings()) {
    const styles = getStyles(settings);
    if (!styles.some(st => st.id === selectedStyleId)) {
        selectedStyleId = settings.activeStyleId || styles[0]?.id || '';
    }
    return styles.find(st => st.id === selectedStyleId) || null;
}

function getStylePreview(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return 'Пустой стиль';
    return text.length > 50 ? `${text.slice(0, 50).trimEnd()}...` : text;
}

function buildStyleListHtml(settings = getSettings()) {
    const styles = getStyles(settings);
    const activeId = settings.activeStyleId;
    getSelectedStyle(settings);
    const searchHtml = styles.length > 8 || styleSearchQuery ? `
        <label class="iig-style-search-wrap">
            <i class="fa-solid fa-magnifying-glass"></i>
            <input id="iig_style_search" class="text_pole" type="search" value="${sanitizeForHtml(styleSearchQuery)}" placeholder="Поиск стилей">
        </label>` : '';
    const rowsHtml = styles.map(st => `
        <div class="iig-style-item ${st.id === activeId ? 'active' : ''} ${st.id === selectedStyleId ? 'selected' : ''}" data-style-id="${sanitizeForHtml(st.id)}" data-style-search="${sanitizeForHtml(`${st.name} ${st.value}`.toLowerCase())}">
            <button type="button" class="menu_button iig-style-activation" data-style-activate="${sanitizeForHtml(st.id)}" title="${st.id === activeId ? 'Выключить' : 'Сделать активным'}">
                <i class="fa-solid ${st.id === activeId ? 'fa-circle-check' : 'fa-circle'}"></i>
            </button>
            <button type="button" class="menu_button iig-style-item-select" data-style-select="${sanitizeForHtml(st.id)}">
                <strong>${st.imagePath ? '<i class="fa-solid fa-image" title="Есть картинка-референс"></i> ' : ''}${sanitizeForHtml(st.name)}</strong>
                <small>${sanitizeForHtml(getStylePreview(st.value))}</small>
            </button>
            <div class="iig-style-item-actions">
                <button type="button" class="menu_button" data-style-duplicate="${sanitizeForHtml(st.id)}" title="Копия"><i class="fa-solid fa-copy"></i></button>
                <button type="button" class="menu_button redWarningBG" data-style-remove="${sanitizeForHtml(st.id)}" title="Удалить"><i class="fa-solid fa-trash"></i></button>
            </div>
        </div>`).join('');

    return `
        ${searchHtml}
        <div class="iig-style-list">
            <button type="button" class="menu_button iig-style-none" data-style-disable aria-pressed="${!activeId}">
                <i class="fa-solid fa-ban"></i>
                <span>Без стиля (из тега)</span>
            </button>
            ${rowsHtml ? `${rowsHtml}<div class="iig-library-empty iig-style-search-empty iig-hidden" role="status">Ничего не найдено.</div>` : '<div class="iig-library-empty">Стилей пока нет.</div>'}
        </div>`;
}

function buildStyleEditorHtml(settings = getSettings()) {
    const style = getSelectedStyle(settings);
    if (!style) return '<div class="iig-library-empty iig-style-editor-empty">Стилей пока нет.</div>';
    const isActive = style.id === settings.activeStyleId;
    const preview = style.imagePath
        ? `<img class="iig-style-image-preview" src="${sanitizeForHtml(style.imagePath)}" alt="">`
        : '<div class="iig-style-image-preview iig-style-image-empty"><i class="fa-solid fa-image"></i></div>';
    return `
        <div class="iig-style-editor-content">
            <div class="iig-style-editor-status ${isActive ? 'active' : ''}">
                <i class="fa-solid ${isActive ? 'fa-circle-check' : 'fa-circle'}"></i>
                <span>${isActive ? 'Активен' : 'Неактивен'}</span>
            </div>
            <label class="iig-style-field" for="iig_style_name">
                <span>Название</span>
                <input type="text" id="iig_style_name" class="text_pole" value="${sanitizeForHtml(style.name)}">
            </label>
            <label class="iig-style-field" for="iig_style_value">
                <span>Стиль</span>
                <textarea id="iig_style_value" class="text_pole" rows="6" placeholder="semi_realism, muted colors, soft lighting">${sanitizeForHtml(style.value)}</textarea>
            </label>
            <div class="iig-style-field">
                <span>Картинка-референс стиля</span>
                <div class="iig-style-image-row">
                    ${preview}
                    <div class="iig-style-image-actions">
                        <label class="menu_button iig-button-inline">
                            <i class="fa-solid fa-upload"></i><span>${style.imagePath ? 'Заменить' : 'Загрузить'}</span>
                            <input type="file" id="iig_style_image_file" accept="image/*" style="display:none">
                        </label>
                        ${style.imagePath ? '<button type="button" id="iig_style_image_remove" class="menu_button iig-button-inline"><i class="fa-solid fa-xmark"></i><span>Убрать</span></button>' : ''}
                    </div>
                </div>
            </div>
            <div class="iig-style-editor-actions">
                <button type="button" id="iig_style_toggle_active" class="menu_button iig-button-inline">
                    <i class="fa-solid ${isActive ? 'fa-ban' : 'fa-circle-check'}"></i>
                    <span>${isActive ? 'Выключить' : 'Сделать активным'}</span>
                </button>
                <button type="button" id="iig_style_duplicate" class="menu_button iig-button-inline"><i class="fa-solid fa-copy"></i><span>Копия</span></button>
                <button type="button" id="iig_style_remove" class="menu_button iig-button-inline redWarningBG"><i class="fa-solid fa-trash"></i><span>Удалить</span></button>
                <span class="iig-style-autosave"><i class="fa-solid fa-floppy-disk"></i> Автосохранение</span>
            </div>
        </div>`;
}

function filterStyleList() {
    const query = styleSearchQuery.trim().toLowerCase();
    let visibleCount = 0;
    document.querySelectorAll('#iig_style_presets .iig-style-item').forEach((item) => {
        const visible = !query || String(item.getAttribute('data-style-search') || '').includes(query);
        item.classList.toggle('iig-hidden', !visible);
        if (visible) visibleCount++;
    });
    document.querySelector('#iig_style_presets .iig-style-search-empty')?.classList.toggle('iig-hidden', !query || visibleCount > 0);
}

function renderStyleSection() {
    const settings = getSettings();
    const list = document.getElementById('iig_style_presets');
    const editor = document.getElementById('iig_style_editor');
    if (!list || !editor) return;
    // Сохраняем прокрутку списка, иначе после клика он прыгает наверх.
    const scrollTop = list.querySelector('.iig-style-list')?.scrollTop || 0;
    list.innerHTML = buildStyleListHtml(settings);
    const newList = list.querySelector('.iig-style-list');
    if (newList) newList.scrollTop = scrollTop;
    filterStyleList();
    editor.innerHTML = buildStyleEditorHtml(settings);
}

function setActiveStyle(styleId) {
    const settings = getSettings();
    settings.activeStyleId = styleId;
    saveSettings();
    renderStyleSection();
}

function duplicateStyle(styleId) {
    const settings = getSettings();
    const source = getStyles(settings).find(st => st.id === styleId);
    if (!source) return;
    const copy = { id: makeStyleId(), name: `Копия ${source.name}`, value: source.value, imagePath: source.imagePath };
    settings.styles.splice(settings.styles.indexOf(source) + 1, 0, copy);
    selectedStyleId = copy.id;
    saveSettings();
    renderStyleSection();
}

async function deleteStyle(styleId) {
    const settings = getSettings();
    const style = getStyles(settings).find(st => st.id === styleId);
    if (!style) return;
    if (!await askConfirm('Удалить стиль?', `«${style.name}» будет удалён.`)) return;
    settings.styles = settings.styles.filter(st => st.id !== styleId);
    if (settings.activeStyleId === styleId) settings.activeStyleId = '';
    if (selectedStyleId === styleId) selectedStyleId = '';
    saveSettings();
    renderStyleSection();
}

function bindStyleEvents() {
    const settings = getSettings();
    const list = document.getElementById('iig_style_presets');
    const editor = document.getElementById('iig_style_editor');
    if (!list || !editor) return;

    document.getElementById('iig_style_add')?.addEventListener('click', () => {
        const style = { id: makeStyleId(), name: `Стиль ${getStyles(settings).length + 1}`, value: '', imagePath: '' };
        settings.styles.push(style);
        selectedStyleId = style.id;
        styleSearchQuery = '';
        saveSettings();
        renderStyleSection();
        document.getElementById('iig_style_name')?.select();
    });

    list.addEventListener('input', (e) => {
        if (e.target.id !== 'iig_style_search') return;
        styleSearchQuery = e.target.value;
        filterStyleList();
    });

    list.addEventListener('click', async (e) => {
        const target = e.target instanceof Element ? e.target : null;
        if (!target) return;
        if (target.closest('[data-style-disable]')) { setActiveStyle(''); return; }
        const activate = target.closest('[data-style-activate]');
        if (activate) {
            const id = activate.getAttribute('data-style-activate');
            setActiveStyle(settings.activeStyleId === id ? '' : id);
            return;
        }
        const select = target.closest('[data-style-select]');
        if (select) {
            selectedStyleId = select.getAttribute('data-style-select');
            renderStyleSection();
            return;
        }
        const duplicate = target.closest('[data-style-duplicate]');
        if (duplicate) { duplicateStyle(duplicate.getAttribute('data-style-duplicate')); return; }
        const remove = target.closest('[data-style-remove]');
        if (remove) await deleteStyle(remove.getAttribute('data-style-remove'));
    });

    // Поля редактора пересоздаются при рендере, поэтому события ловим на контейнере.
    editor.addEventListener('input', (e) => {
        const style = getSelectedStyle(settings);
        if (!style) return;
        if (e.target.id === 'iig_style_name') style.name = e.target.value;
        else if (e.target.id === 'iig_style_value') style.value = e.target.value;
        else return;
        saveSettings();
        // Обновляем только строку в списке, чтобы не сбить фокус в редакторе.
        const row = list.querySelector(`.iig-style-item[data-style-id="${CSS.escape(style.id)}"]`);
        if (row) {
            const title = row.querySelector('strong');
            if (title) title.innerHTML = `${style.imagePath ? '<i class="fa-solid fa-image"></i> ' : ''}${sanitizeForHtml(style.name || 'Стиль')}`;
            const preview = row.querySelector('small');
            if (preview) preview.textContent = getStylePreview(style.value);
            row.setAttribute('data-style-search', `${style.name} ${style.value}`.toLowerCase());
            filterStyleList();
        }
    });

    editor.addEventListener('change', async (e) => {
        if (e.target.id !== 'iig_style_image_file') return;
        const style = getSelectedStyle(settings);
        const file = e.target.files?.[0];
        if (!style || !file) return;
        try {
            const rawBase64 = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result.split(',')[1]);
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
            const compressed = await compressBase64Image(rawBase64, 1024, 0.85);
            style.imagePath = await saveRefImageToFile(compressed, `style_${style.name}`);
            saveSettings();
            renderStyleSection();
            toastr.success(`Картинка стиля «${style.name}» сохранена`, 'Генерация картинок', { timeOut: 2000 });
        } catch (err) {
            iigLog('ERROR', 'Style image upload failed:', err.message);
            toastr.error(`Не удалось загрузить картинку: ${err.message}`, 'Генерация картинок');
        }
        e.target.value = '';
    });

    editor.addEventListener('click', async (e) => {
        const target = e.target instanceof Element ? e.target : null;
        const style = getSelectedStyle(settings);
        if (!target || !style) return;
        if (target.closest('#iig_style_toggle_active')) {
            setActiveStyle(settings.activeStyleId === style.id ? '' : style.id);
        } else if (target.closest('#iig_style_duplicate')) {
            duplicateStyle(style.id);
        } else if (target.closest('#iig_style_remove')) {
            await deleteStyle(style.id);
        } else if (target.closest('#iig_style_image_remove')) {
            style.imagePath = '';
            saveSettings();
            renderStyleSection();
        }
    });

    renderStyleSection();
}

function renderProfileSelect() {
    const select = document.getElementById('iig_profile_select');
    if (!select) return;
    const settings = getSettings();
    select.innerHTML = getConnectionProfiles(settings).map(p =>
        `<option value="${sanitizeForHtml(p.id)}" ${p.id === settings.activeConnectionProfileId ? 'selected' : ''}>${sanitizeForHtml(p.name)}</option>`
    ).join('');
    document.getElementById('iig_profile_remove')?.classList.toggle('disabled', settings.connectionProfiles.length <= 1);
}

// После загрузки профиля переписываем поля формы из настроек.
function applyConnectionFieldsToUI() {
    const settings = getSettings();
    const setValue = (id, value) => { const el = document.getElementById(id); if (el) el.value = value ?? ''; };
    const setChecked = (id, value) => { const el = document.getElementById(id); if (el) el.checked = !!value; };
    setValue('iig_endpoint', settings.endpoint);
    setValue('iig_api_key', settings.apiKey);
    const model = document.getElementById('iig_model');
    if (model) {
        model.innerHTML = settings.model
            ? `<option value="${sanitizeForHtml(settings.model)}" selected>${sanitizeForHtml(settings.model)}</option>`
            : '<option value="">-- Выберите модель --</option>';
    }
    setValue('iig_size', settings.size);
    setValue('iig_quality', settings.quality);
    setValue('iig_aspect_ratio', settings.aspectRatio);
    setValue('iig_image_size', settings.imageSize);
    setValue('iig_naistera_aspect_ratio', settings.naisteraAspectRatio);
    setValue('iig_naistera_preset', settings.naisteraPreset);
    setChecked('iig_send_char_avatar', settings.sendCharAvatar);
    setChecked('iig_send_user_avatar', settings.sendUserAvatar);
    document.getElementById('iig_user_avatar_manual_section')?.classList.toggle('iig-hidden', !settings.sendUserAvatar);
    selectUserAvatar(settings.userAvatarFile || '');
    // Тип API последним: его обработчик обновляет видимость полей.
    const apiType = document.getElementById('iig_api_type');
    if (apiType) { apiType.value = settings.apiType; apiType.dispatchEvent(new Event('change')); }
    renderProfileSelect();
    updateHeaderStatusDot();
}

function bindProfileEvents() {
    const settings = getSettings();
    document.getElementById('iig_profile_select')?.addEventListener('change', (e) => {
        const profile = loadConnectionProfile(e.target.value);
        if (!profile) return;
        applyConnectionFieldsToUI();
        toastr.info(`Профиль «${profile.name}»`, 'Генерация картинок', { timeOut: 1500 });
    });
    document.getElementById('iig_profile_add')?.addEventListener('click', async () => {
        const name = await askText('Название нового профиля', `Профиль ${getConnectionProfiles(settings).length + 1}`);
        if (name === null || name === undefined || name === false) return;
        const profile = createConnectionProfile(name);
        renderProfileSelect();
        toastr.success(`Создан профиль «${profile.name}» — копия текущих настроек`, 'Генерация картинок', { timeOut: 2500 });
    });
    document.getElementById('iig_profile_rename')?.addEventListener('click', async () => {
        const active = getActiveConnectionProfile(settings);
        if (!active) return;
        const name = await askText('Новое название профиля', active.name);
        if (!name) return;
        renameConnectionProfile(active.id, name);
        renderProfileSelect();
    });
    document.getElementById('iig_profile_remove')?.addEventListener('click', async () => {
        const active = getActiveConnectionProfile(settings);
        if (!active) return;
        if (settings.connectionProfiles.length <= 1) {
            toastr.warning('Нельзя удалить последний профиль', 'Генерация картинок');
            return;
        }
        if (!await askConfirm('Удалить профиль?', `«${active.name}» будет удалён.`)) return;
        removeConnectionProfile(active.id);
        applyConnectionFieldsToUI();
    });
    renderProfileSelect();
}

function bindSettingsEvents() {
    const settings = getSettings();
    bindStyleEvents();
    bindProfileEvents();

    const updateVisibility = () => {
        const apiType = settings.apiType;
        const isNaistera = apiType === 'naistera';
        const isGemini = apiType === 'gemini';
        document.getElementById('iig_model_row')?.classList.toggle('iig-hidden', isNaistera);
        document.getElementById('iig_naistera_aspect_row')?.classList.toggle('iig-hidden', !isNaistera);
        document.getElementById('iig_naistera_preset_row')?.classList.toggle('iig-hidden', !isNaistera);
        document.getElementById('iig_naistera_hint')?.classList.toggle('iig-hidden', !isNaistera);
        document.getElementById('iig_gemini_params')?.classList.toggle('iig-hidden', !isGemini);
        document.getElementById('iig_image_context_section')?.classList.toggle('iig-hidden', !(isNaistera || isGemini));
        document.getElementById('iig_image_context_count_row')?.classList.toggle('iig-hidden', !(settings.imageContextEnabled && (isNaistera || isGemini)));
    };

    document.getElementById('iig_enabled')?.addEventListener('change', (e) => {
        settings.enabled = e.target.checked;
        saveSettings();
        updateHeaderStatusDot();
    });

    document.getElementById('iig_ref_instruction_enabled')?.addEventListener('change', (e) => {
        settings.refInstructionEnabled = e.target.checked;
        const area = document.getElementById('iig_ref_instruction');
        if (area) area.disabled = !e.target.checked;
        saveSettings();
    });
    document.getElementById('iig_ref_instruction')?.addEventListener('input', (e) => {
        // Стандартный текст храним пустой строкой: тогда обновления текста по умолчанию доедут.
        const text = e.target.value.trim();
        settings.refInstruction = text === DEFAULT_REF_INSTRUCTION ? '' : text;
        saveSettings();
    });
    document.getElementById('iig_ref_instruction_reset')?.addEventListener('click', () => {
        settings.refInstruction = '';
        const area = document.getElementById('iig_ref_instruction');
        if (area) area.value = DEFAULT_REF_INSTRUCTION;
        saveSettings();
        toastr.info('Текст инструкции сброшен', 'Генерация картинок', { timeOut: 1500 });
    });

    document.getElementById('iig_external_blocks')?.addEventListener('change', (e) => {
        settings.externalBlocks = e.target.checked;
        saveSettings();
    });
    document.getElementById('iig_api_type')?.addEventListener('change', (e) => {
        settings.apiType = e.target.value;
        saveSettings();
        updateVisibility();
    });

    // Avatar checkboxes
    document.getElementById('iig_send_char_avatar')?.addEventListener('change', (e) => {
        settings.sendCharAvatar = e.target.checked;
        saveSettings();
    });

    document.getElementById('iig_send_user_avatar')?.addEventListener('change', (e) => {
        settings.sendUserAvatar = e.target.checked;
        saveSettings();
        const sec = document.getElementById('iig_user_avatar_manual_section');
        if (sec) sec.classList.toggle('iig-hidden', !e.target.checked);
    });

    // Collapsible manual photo sections
    function bindPhotoToggle(toggleId, sectionId, settingKey) {
        document.getElementById(toggleId)?.addEventListener('click', () => {
            const s = getSettings();
            s[settingKey] = !s[settingKey];
            saveSettings();
            const sec = document.getElementById(sectionId);
            if (sec) sec.classList.toggle('iig-hidden', !s[settingKey]);
            const icon = document.querySelector(`#${toggleId} .fa-chevron-right, #${toggleId} .fa-chevron-down`);
            if (icon) { icon.classList.toggle('fa-chevron-right', !s[settingKey]); icon.classList.toggle('fa-chevron-down', s[settingKey]); }
        });
    }
    bindPhotoToggle('iig_char_photo_toggle', 'iig_char_photo_section', 'charPhotoOpen');
    bindPhotoToggle('iig_user_photo_toggle', 'iig_user_photo_section', 'userPhotoOpen');

    // Avatar dropdown toggle
    document.getElementById('iig_user_avatar_dropdown_selected')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const dropdown = document.getElementById('iig_user_avatar_dropdown');
        if (!dropdown) return;
        const wasOpen = dropdown.classList.contains('open');
        dropdown.classList.toggle('open');
        if (!wasOpen) {
            const list = document.getElementById('iig_user_avatar_dropdown_list');
            if (list && list.children.length === 0) loadAndRenderUserAvatars();
        }
    });

    document.addEventListener('click', (e) => {
        const dropdown = document.getElementById('iig_user_avatar_dropdown');
        if (dropdown && !dropdown.contains(e.target)) dropdown.classList.remove('open');
    });

    document.getElementById('iig_user_avatar_refresh')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        const btn = e.currentTarget;
        btn.classList.add('loading');
        await loadAndRenderUserAvatars();
        btn.classList.remove('loading');
        toastr.success('Аватары обновлены', '');
        const dropdown = document.getElementById('iig_user_avatar_dropdown');
        if (dropdown) dropdown.classList.add('open');
    });
    document.getElementById('iig_endpoint')?.addEventListener('input', (e) => { settings.endpoint = e.target.value; saveSettings(); });

    document.querySelectorAll('.iig-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const url = btn.dataset.presetUrl;
            const type = btn.dataset.presetType;
            settings.endpoint = url;
            const input = document.getElementById('iig_endpoint');
            if (input) input.value = url;
            if (type) { settings.apiType = type; const sel = document.getElementById('iig_api_type'); if (sel) sel.value = type; updateVisibility(); }
            saveSettings();
            toastr.info(`Эндпоинт: ${url}`, 'Генерация картинок', { timeOut: 2000 });
        });
    });

    document.getElementById('iig_api_key')?.addEventListener('input', (e) => { settings.apiKey = e.target.value; saveSettings(); });
    document.getElementById('iig_key_toggle')?.addEventListener('click', () => {
        const input = document.getElementById('iig_api_key');
        const icon = document.querySelector('#iig_key_toggle i');
        if (input.type === 'password') { input.type = 'text'; icon.classList.replace('fa-eye', 'fa-eye-slash'); }
        else { input.type = 'password'; icon.classList.replace('fa-eye-slash', 'fa-eye'); }
    });
    document.getElementById('iig_model')?.addEventListener('change', (e) => {
        settings.model = e.target.value;
        saveSettings();
        if (isGeminiModel(e.target.value)) {
            document.getElementById('iig_api_type').value = 'gemini';
            settings.apiType = 'gemini';
            updateVisibility();
        }
    });
    document.getElementById('iig_refresh_models')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.classList.add('loading');
        try {
            const models = await fetchModels();
            const select = document.getElementById('iig_model');
            const cur = settings.model;
            select.innerHTML = '<option value="">-- Выберите модель --</option>';
            for (const m of models) {
                const opt = document.createElement('option');
                opt.value = m; opt.textContent = m; opt.selected = m === cur;
                select.appendChild(opt);
            }
            toastr.success(`Найдено моделей: ${models.length}`, 'Генерация картинок');
        } catch (e) { toastr.error('Ошибка загрузки моделей', 'Генерация картинок'); }
        finally { btn.classList.remove('loading'); }
    });
    document.getElementById('iig_size')?.addEventListener('change', (e) => { settings.size = e.target.value; saveSettings(); });
    document.getElementById('iig_quality')?.addEventListener('change', (e) => { settings.quality = e.target.value; saveSettings(); });
    document.getElementById('iig_aspect_ratio')?.addEventListener('change', (e) => { settings.aspectRatio = e.target.value; saveSettings(); });
    document.getElementById('iig_image_size')?.addEventListener('change', (e) => { settings.imageSize = e.target.value; saveSettings(); });
    document.getElementById('iig_naistera_aspect_ratio')?.addEventListener('change', (e) => { settings.naisteraAspectRatio = e.target.value; saveSettings(); });
    document.getElementById('iig_naistera_preset')?.addEventListener('change', (e) => { settings.naisteraPreset = e.target.value; saveSettings(); });
    document.getElementById('iig_max_retries')?.addEventListener('input', (e) => {
        const v = parseInt(e.target.value, 10);
        settings.maxRetries = Number.isNaN(v) ? 0 : Math.max(0, Math.min(5, v));
        saveSettings();
    });
    document.getElementById('iig_retry_delay')?.addEventListener('input', (e) => {
        const v = parseInt(e.target.value, 10);
        settings.retryDelay = Number.isNaN(v) ? 1000 : Math.max(500, v);
        saveSettings();
    });
    document.getElementById('iig_export_logs')?.addEventListener('click', () => exportLogs());
    document.getElementById('iig_show_last_request')?.addEventListener('click', () => showLastImageRequest());

    document.getElementById('iig_image_context_enabled')?.addEventListener('change', (e) => {
        settings.imageContextEnabled = e.target.checked;
        saveSettings();
        updateVisibility();
    });

    document.getElementById('iig_image_context_count')?.addEventListener('input', (e) => {
        const normalized = normalizeImageContextCount(e.target.value);
        settings.imageContextCount = normalized;
        e.target.value = String(normalized);
        saveSettings();
    });

    // Test connection
    document.getElementById('iig_test_connection')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        if (btn.classList.contains('testing')) return;
        btn.classList.add('testing');
        const icon = btn.querySelector('i');
        const origClass = icon.className;
        icon.className = 'fa-solid fa-spinner';
        try {
            if (!settings.endpoint || !settings.apiKey) throw new Error('Настройте эндпоинт и API ключ');
            if (settings.apiType === 'naistera') {
                const resp = await fetch(settings.endpoint.replace(/\/$/, ''), { method: 'HEAD' }).catch(() => null);
                toastr[resp?.ok ? 'success' : 'warning']('Соединение ' + (resp?.ok ? 'OK' : 'установлено (non-OK)'), 'Генерация картинок');
            } else {
                const models = await fetchModels();
                toastr.success(`OK — найдено ${models.length} моделей`, 'Генерация картинок');
            }
            btn.classList.add('test-success');
            setTimeout(() => btn.classList.remove('test-success'), 700);
        } catch (error) {
            toastr.error(`Ошибка: ${error.message}`, 'Генерация картинок');
            btn.classList.add('test-fail');
            setTimeout(() => btn.classList.remove('test-fail'), 700);
        } finally { btn.classList.remove('testing'); icon.className = origClass; }
    });

    // Char/User ref slots
    bindRefSlotEvents();

    // NPC single slot
    bindNpcSlotEvent();

    // Wardrobe section
    document.getElementById('sw_max_dim')?.addEventListener('change', (e) => {
        const ctx = SillyTavern.getContext();
        const s = ctx.extensionSettings['silly_wardrobe'];
        if (s) { s.maxDimension = Math.max(128, Math.min(1024, parseInt(e.target.value) || 512)); ctx.saveSettingsDebounced(); }
    });

    // ── Vision settings handlers ──
    document.getElementById('sw_vision_endpoint')?.addEventListener('input', (e) => {
        const ctx = SillyTavern.getContext();
        const s = ctx.extensionSettings['silly_wardrobe'];
        if (s) { s.visionEndpoint = e.target.value.trim(); ctx.saveSettingsDebounced(); }
    });
    document.getElementById('sw_vision_apikey')?.addEventListener('input', (e) => {
        const ctx = SillyTavern.getContext();
        const s = ctx.extensionSettings['silly_wardrobe'];
        if (s) { s.visionApiKey = e.target.value.trim(); ctx.saveSettingsDebounced(); }
    });
    document.getElementById('sw_vision_model')?.addEventListener('input', (e) => {
        const ctx = SillyTavern.getContext();
        const s = ctx.extensionSettings['silly_wardrobe'];
        if (s) { s.visionModel = e.target.value.trim(); ctx.saveSettingsDebounced(); }
    });
    document.getElementById('sw_vision_key_toggle')?.addEventListener('click', () => {
        const input = document.getElementById('sw_vision_apikey');
        const icon = document.querySelector('#sw_vision_key_toggle i');
        if (!input) return;
        if (input.type === 'password') { input.type = 'text'; icon?.classList.replace('fa-eye', 'fa-eye-slash'); }
        else { input.type = 'password'; icon?.classList.replace('fa-eye-slash', 'fa-eye'); }
    });
    document.getElementById('sw_vision_test')?.addEventListener('click', async () => {
        const btn = document.getElementById('sw_vision_test');
        const ctx = SillyTavern.getContext();
        const s = ctx.extensionSettings['silly_wardrobe'] || {};
        const endpoint = (s.visionEndpoint || '').trim().replace(/\/$/, '');
        const apiKey = (s.visionApiKey || '').trim();
        const model = (s.visionModel || '').trim();
        if (!endpoint || !apiKey || !model) {
            toastr.warning('Заполни Endpoint, API Key и Модель', 'Vision тест');
            return;
        }
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Тестирую...';
        try {
            const resp = await fetch(`${endpoint}/v1/models`, {
                headers: { 'Authorization': `Bearer ${apiKey}` }
            });
            if (resp.ok) {
                toastr.success(`Vision OK — endpoint доступен`, 'Vision тест', { timeOut: 3000 });
            } else {
                toastr.warning(`HTTP ${resp.status} — проверь настройки`, 'Vision тест');
            }
        } catch(e) {
            toastr.error('Ошибка: ' + e.message, 'Vision тест');
        }
        btn.innerHTML = '<i class="fa-solid fa-vial"></i> Тест Vision';
    });

    document.getElementById('sw_clear_all')?.addEventListener('click', () => {
        if (confirm('Удалить ВСЕ аутфиты для всех персонажей?')) {
            const ctx = SillyTavern.getContext();
            const s = ctx.extensionSettings['silly_wardrobe'];
            if (s) { s.wardrobes = {}; ctx.saveSettingsDebounced(); }
            toastr.info('Все аутфиты удалены', 'Гардероб');
            if (window.sillyWardrobe?.refreshDisplay) window.sillyWardrobe.refreshDisplay();
        }
    });

    updateVisibility();
}

function bindRefSlotEvents() {
    for (const slot of document.querySelectorAll('.iig-ref-slot[data-ref-type]')) {
        const refType = slot.dataset.refType;
        const npcIndex = parseInt(slot.dataset.npcIndex, 10);

        slot.querySelector('.iig-ref-name')?.addEventListener('input', (e) => {
            const s = getCurrentCharacterRefs();
            if (refType === 'npc') {
                if (!s.npcReferences[npcIndex]) s.npcReferences[npcIndex] = { name: '', imageBase64: '', imagePath: '' };
                s.npcReferences[npcIndex].name = e.target.value;
            }
            saveSettings();
        });

        slot.querySelector('.iig-ref-file-input')?.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
                const rawBase64 = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result.split(',')[1]);
                    reader.onerror = reject;
                    reader.readAsDataURL(file);
                });
                const compressed = await compressBase64Image(rawBase64, 768, 0.8);

                // KEY FIX: save image as a real file on server, store only the path.
                // Storing base64 in extensionSettings bloats the JSON → silent save failure on mobile.
                const label = refType === 'npc' ? `npc${npcIndex}` : refType;
                const savedPath = await saveRefImageToFile(compressed, label);

                const s = getCurrentCharacterRefs();
                if (refType === 'char') {
                    s.charRef.imageBase64 = '';
                    s.charRef.imagePath = savedPath;
                } else if (refType === 'user') {
                    s.userRef.imageBase64 = '';
                    s.userRef.imagePath = savedPath;
                } else if (refType === 'npc') {
                    if (!s.npcReferences[npcIndex]) s.npcReferences[npcIndex] = { name: '', imageBase64: '', imagePath: '' };
                    s.npcReferences[npcIndex].imageBase64 = '';
                    s.npcReferences[npcIndex].imagePath = savedPath;
                }
                saveSettings();
                const thumb = slot.querySelector('.iig-ref-thumb');
                if (thumb) thumb.src = savedPath;
                iigLog('INFO', `Ref slot ${label}: saved to ${savedPath}`);
                toastr.success('Фото сохранено на сервере', 'Генерация картинок', { timeOut: 2000 });
            } catch (err) {
                const label = refType === 'npc' ? `NPC ${npcIndex}` : refType;
                iigLog('ERROR', `Ref slot ${label}: upload failed`, err.message);
                toastr.error('Ошибка загрузки фото', 'Генерация картинок');
            }
            e.target.value = '';
        });

        slot.querySelector('.iig-ref-delete-btn')?.addEventListener('click', () => {
            const s = getCurrentCharacterRefs();
            if (refType === 'char') s.charRef = { name: '', imageBase64: '', imagePath: '' };
            else if (refType === 'user') s.userRef = { name: '', imageBase64: '', imagePath: '' };
            else if (refType === 'npc') s.npcReferences[npcIndex] = { name: '', imageBase64: '', imagePath: '' };
            saveSettingsNow();
            const thumb = slot.querySelector('.iig-ref-thumb');
            if (thumb) thumb.src = '';
            const nameEl = slot.querySelector('.iig-ref-name');
            if (nameEl) nameEl.value = '';
            const label = refType === 'npc' ? `NPC ${npcIndex}` : refType;
            // Remove green dot from toggle
            const toggleId = refType === 'char' ? 'iig_char_photo_toggle' : refType === 'user' ? 'iig_user_photo_toggle' : null;
            if (toggleId) document.querySelector(`#${toggleId} .fa-circle`)?.remove();
            iigLog('INFO', `Ref slot ${label}: cleared`);
            toastr.info('Слот очищен', 'Генерация картинок', { timeOut: 2000 });
        });
    }
}

/* ── Lightbox ── */
function initLightbox() {
    if (document.getElementById('iig_lightbox')) return;
    const overlay = document.createElement('div');
    overlay.id = 'iig_lightbox';
    overlay.className = 'iig-lightbox';
    overlay.innerHTML = `
        <div class="iig-lightbox-backdrop"></div>
        <button class="iig-lightbox-close" title="Закрыть"><i class="fa-solid fa-xmark"></i></button>
        <button class="iig-lightbox-download" title="Скачать"><i class="fa-solid fa-download"></i></button>
        <button class="iig-lightbox-nav iig-lightbox-prev" title="Предыдущая"><i class="fa-solid fa-chevron-left"></i></button>
        <button class="iig-lightbox-nav iig-lightbox-next" title="Следующая"><i class="fa-solid fa-chevron-right"></i></button>
        <div class="iig-lightbox-counter"></div>
        <div class="iig-lightbox-content">
            <img class="iig-lightbox-img" src="" alt="Full-size preview" draggable="false">
            <div class="iig-lightbox-caption"></div>
            <div class="iig-lightbox-hint">Колёсико / щипок — зум &nbsp;·&nbsp; двойной тап — 2.5× &nbsp;·&nbsp; свайп или ← → — листать</div>
        </div>
    `;

    // ── Append to <html> to bypass transform ancestors on mobile ST ──
    // (same fix as wardrobe modal — position:fixed breaks inside transforms)
    document.documentElement.appendChild(overlay);

    let _lbRO = null;
    function _fixPos() {
        overlay.style.position = 'fixed';
        overlay.style.top    = '0px';
        overlay.style.left   = '0px';
        overlay.style.width  = window.innerWidth  + 'px';
        overlay.style.height = window.innerHeight + 'px';
    }

    const imgEl     = overlay.querySelector('.iig-lightbox-img');
    const captionEl = overlay.querySelector('.iig-lightbox-caption');

    // ── Zoom state ──────────────────────────────────────────────────
    let sc = 1, tx = 0, ty = 0;

    function resetZoom() {
        sc = 1; tx = 0; ty = 0;
        imgEl.style.transform = '';
        imgEl.style.cursor    = 'zoom-in';
        overlay.querySelector('.iig-lightbox-content').classList.remove('iig-lb-zoomed');
    }

    function applyZoom() {
        imgEl.style.transform = `scale(${sc}) translate(${tx}px, ${ty}px)`;
        imgEl.style.cursor = sc > 1 ? 'grab' : 'zoom-in';
        overlay.querySelector('.iig-lightbox-content').classList.toggle('iig-lb-zoomed', sc > 1);
    }

    // Desktop — wheel zoom (centred on image)
    imgEl.addEventListener('wheel', (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
        sc = Math.min(6, Math.max(1, sc * factor));
        if (sc <= 1.01) { resetZoom(); return; }
        applyZoom();
    }, { passive: false });

    // Desktop — drag when zoomed
    let _drag = false, _dx = 0, _dy = 0, _tx0 = 0, _ty0 = 0;
    imgEl.addEventListener('mousedown', (e) => {
        if (sc <= 1) return;
        _drag = true; _dx = e.clientX; _dy = e.clientY; _tx0 = tx; _ty0 = ty;
        imgEl.style.cursor = 'grabbing';
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
        if (!_drag) return;
        tx = _tx0 + (e.clientX - _dx) / sc;
        ty = _ty0 + (e.clientY - _dy) / sc;
        applyZoom();
    });
    document.addEventListener('mouseup', () => {
        if (_drag) { _drag = false; imgEl.style.cursor = sc > 1 ? 'grab' : 'zoom-in'; }
    });

    // Mobile — pinch-to-zoom + double-tap + single-finger pan
    let _t0 = null, _t1 = null, _startDist = 0, _startSc = 1;
    let _tapCount = 0, _tapTimer = null;
    // pan state
    let _panActive = false, _panX = 0, _panY = 0, _panTx0 = 0, _panTy0 = 0, _panMoved = false;

    imgEl.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
            // cancel any pan in progress
            _panActive = false;
            _t0 = e.touches[0]; _t1 = e.touches[1];
            _startDist = Math.hypot(_t1.clientX - _t0.clientX, _t1.clientY - _t0.clientY);
            _startSc = sc;
            e.preventDefault();
        } else if (e.touches.length === 1) {
            const touch = e.touches[0];
            if (sc > 1) {
                // start pan
                _panActive = true; _panMoved = false;
                _panX = touch.clientX; _panY = touch.clientY;
                _panTx0 = tx; _panTy0 = ty;
                e.preventDefault();
            }
            // double-tap detection (only register if not already dragging)
            _tapCount++;
            clearTimeout(_tapTimer);
            if (_tapCount >= 2) {
                _tapCount = 0;
                if (sc > 1) { resetZoom(); } else { sc = 2.5; tx = 0; ty = 0; applyZoom(); }
                _panActive = false;
                e.preventDefault();
            } else {
                _tapTimer = setTimeout(() => { _tapCount = 0; }, 280);
            }
        }
    }, { passive: false });

    imgEl.addEventListener('touchmove', (e) => {
        if (e.touches.length === 2 && _t0 && _t1) {
            _panActive = false;
            const t0 = e.touches[0], t1 = e.touches[1];
            const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
            sc = Math.min(6, Math.max(1, _startSc * (dist / _startDist)));
            if (sc <= 1.01) { resetZoom(); } else { applyZoom(); }
            e.preventDefault();
        } else if (e.touches.length === 1 && _panActive) {
            const touch = e.touches[0];
            const dx = touch.clientX - _panX;
            const dy = touch.clientY - _panY;
            if (!_panMoved && Math.hypot(dx, dy) > 4) _panMoved = true;
            if (_panMoved) {
                tx = _panTx0 + dx / sc;
                ty = _panTy0 + dy / sc;
                applyZoom();
                e.preventDefault();
            }
        }
    }, { passive: false });

    imgEl.addEventListener('touchend', (e) => {
        if (e.touches.length < 2) { _t0 = null; _t1 = null; }
        if (e.touches.length === 0) { _panActive = false; }
    }, { passive: true });

    // ── Галерея: листаем все сгенерированные картинки чата ──────────
    let gallery = [];   // [{ src, alt }]
    let gIndex = 0;
    const counterEl = overlay.querySelector('.iig-lightbox-counter');

    function collectChatImages() {
        const seen = new Set();
        const out = [];
        for (const img of document.querySelectorAll('#chat .iig-img-wrap img, #chat img.iig-generated-image')) {
            const src = img.getAttribute('src') || '';
            if (!src || src.includes('error.svg') || src.includes('[IMG:') || seen.has(src)) continue;
            seen.add(src);
            out.push({ src, alt: img.alt || '' });
        }
        return out;
    }

    function showAt(i) {
        if (!gallery.length) return;
        gIndex = (i + gallery.length) % gallery.length;
        resetZoom();
        imgEl.src = gallery[gIndex].src;
        captionEl.textContent = gallery[gIndex].alt;
        const multi = gallery.length > 1;
        overlay.classList.toggle('iig-lb-multi', multi);
        counterEl.textContent = multi ? `${gIndex + 1} / ${gallery.length}` : '';
    }

    // Свайп влево/вправо, когда картинка не увеличена.
    let _swX = 0, _swY = 0, _swOn = false;
    imgEl.addEventListener('touchstart', (e) => {
        _swOn = e.touches.length === 1 && sc <= 1;
        if (_swOn) { _swX = e.touches[0].clientX; _swY = e.touches[0].clientY; }
    }, { passive: true });
    imgEl.addEventListener('touchend', (e) => {
        if (!_swOn || sc > 1 || gallery.length < 2 || !e.changedTouches.length) { _swOn = false; return; }
        _swOn = false;
        const dx = e.changedTouches[0].clientX - _swX;
        const dy = e.changedTouches[0].clientY - _swY;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) showAt(gIndex + (dx < 0 ? 1 : -1));
    }, { passive: true });

    overlay.querySelector('.iig-lightbox-prev').addEventListener('click', (e) => { e.stopPropagation(); showAt(gIndex - 1); });
    overlay.querySelector('.iig-lightbox-next').addEventListener('click', (e) => { e.stopPropagation(); showAt(gIndex + 1); });
    overlay.querySelector('.iig-lightbox-download').addEventListener('click', (e) => {
        e.stopPropagation();
        if (gallery[gIndex]) downloadGeneratedImage(gallery[gIndex].src);
    });

    // ── Open / close ────────────────────────────────────────────────
    function lbOpen(src, caption) {
        gallery = collectChatImages();
        const idx = gallery.findIndex(g => g.src === src);
        if (idx === -1) { gallery = [{ src, alt: caption || '' }]; showAt(0); }
        else { if (caption) gallery[idx].alt = caption; showAt(idx); }
        _fixPos();
        if (!_lbRO) {
            _lbRO = new ResizeObserver(_fixPos);
            _lbRO.observe(document.documentElement);
        }
        overlay.classList.add('open');
        document.body.style.overflow = 'hidden';      // block body scroll
        document.documentElement.style.overflow = 'hidden';
    }

    function lbClose() {
        overlay.classList.remove('open');
        document.body.style.overflow = '';
        document.documentElement.style.overflow = '';
        resetZoom();
    }

    // Backdrop — click + touch
    const backdrop = overlay.querySelector('.iig-lightbox-backdrop');
    backdrop.addEventListener('click',    lbClose);
    backdrop.addEventListener('touchend', (e) => { e.preventDefault(); lbClose(); }, { passive: false });

    // Close button — click + touch
    const closeBtn = overlay.querySelector('.iig-lightbox-close');
    closeBtn.addEventListener('click',    lbClose);
    closeBtn.addEventListener('touchend', (e) => { e.preventDefault(); lbClose(); }, { passive: false });

    // Escape — закрыть, стрелки — листать (если не увеличено)
    document.addEventListener('keydown', (e) => {
        if (!overlay.classList.contains('open')) return;
        if (e.key === 'Escape') lbClose();
        else if (e.key === 'ArrowLeft' && sc <= 1) { e.preventDefault(); showAt(gIndex - 1); }
        else if (e.key === 'ArrowRight' && sc <= 1) { e.preventDefault(); showAt(gIndex + 1); }
    });

    // ── Единый CAPTURE-обработчик (как в sillyimages): кнопки всегда «выигрывают»
    //    у картинки, поэтому регенерация больше не открывает лайтбокс по ошибке.
    //    Capture-фаза = срабатывает РАНЬШЕ любых других кликов; данные читаем из dataset.
    document.addEventListener('click', (e) => {
        if (e.target.closest('#iig_lightbox')) return; // внутри лайтбокса свои хендлеры

        // 1) Кнопка перегенерации
        const regenBtn = e.target.closest('.iig-corner-regen');
        if (regenBtn) {
            e.preventDefault(); e.stopPropagation();
            const mid = parseInt(regenBtn.dataset.messageId, 10);
            const idx = parseInt(regenBtn.dataset.tagIndex, 10);
            if (!isNaN(mid) && !isNaN(idx)) regenerateSingleImage(mid, idx);
            return;
        }
        // 2) Кнопка «скачать»
        const dlBtn = e.target.closest('.iig-corner-dl');
        if (dlBtn) {
            e.preventDefault(); e.stopPropagation();
            const src = dlBtn.dataset.imgSrc || '';
            if (src && !src.includes('error.svg')) downloadGeneratedImage(src);
            return;
        }
        // 3) Кнопка «на весь экран»
        const fsBtn = e.target.closest('.iig-corner-fs');
        if (fsBtn) {
            e.preventDefault(); e.stopPropagation();
            const src = fsBtn.dataset.imgSrc || '';
            if (src && !src.includes('error.svg')) lbOpen(src, '');
            return;
        }
        // 4) Клик по самой картинке → лайтбокс
        const img = e.target.closest('.iig-img-wrap img, img.iig-generated-image');
        if (img) {
            const src = img.getAttribute('src') || '';
            if (src && !src.includes('error.svg')) {
                e.preventDefault(); e.stopPropagation();
                lbOpen(src, img.alt || '');
            }
        }
    }, true); // ← capture
}

function updateHeaderStatusDot() {
    const settings = getSettings();
    const header = document.querySelector('.inline-drawer-header');
    if (!header) return;
    let dot = header.querySelector('.iig-header-dot');
    if (!dot) {
        dot = document.createElement('span');
        dot.className = 'iig-header-dot';
        const chevron = header.querySelector('.inline-drawer-icon');
        if (chevron) header.insertBefore(dot, chevron);
        else header.appendChild(dot);
    }
    dot.classList.toggle('active', settings.enabled);
    dot.title = settings.enabled ? 'Генерация включена' : 'Генерация выключена';
}

/* ══════════════════════════════════════════════════════════
   REGEN OBSERVER — watches #chat for any generated image
   appearing in the DOM and wraps it with the corner button.
   Handles: new messages, edits, messageFormatting, re-renders.
   ══════════════════════════════════════════════════════════ */
function initRegenObserver() {
    const chat = document.getElementById('chat');
    if (!chat) { setTimeout(initRegenObserver, 500); return; }

    let pending = null;
    const flush = () => {
        pending = null;
        chat.querySelectorAll('.mes[mesid] .mes_text img').forEach((img) => {
            if (img.parentElement?.classList.contains('iig-img-wrap')) return;
            const src = img.src || '';
            const isGenerated =
                img.classList.contains('iig-generated-image') ||
                img.classList.contains('iig-error-image') ||
                img.hasAttribute('data-iig-instruction') ||
                src.includes('/user/images/') ||
                src.includes('iig_');
            if (!isGenerated) return;

            const mesEl = img.closest('.mes[mesid]');
            if (!mesEl) return;
            const messageId = parseInt(mesEl.getAttribute('mesid'), 10);
            if (isNaN(messageId)) return;

            // Index = position among generated images in this message.
            // IMPORTANT: use .iig-img-wrap for already-wrapped images (not the img inside),
            // and only unwrapped imgs for the rest — to avoid double-counting.
            const allGen = Array.from(mesEl.querySelectorAll(
                '.mes_text .iig-img-wrap,' +
                '.mes_text img.iig-generated-image:not(.iig-img-wrap img),' +
                '.mes_text img.iig-error-image:not(.iig-img-wrap img),' +
                '.mes_text img[data-iig-instruction]:not(.iig-img-wrap img),' +
                '.mes_text .iig-loading-placeholder,' +
                '.mes_text .iig-error-placeholder'
            ));
            let idx = allGen.indexOf(img);
            if (idx === -1) {
                // img may not be in allGen yet (race) — count by position in all imgs
                const allImgs = Array.from(mesEl.querySelectorAll('.mes_text img'));
                idx = allImgs.indexOf(img);
            }
            if (idx === -1) idx = 0;

            img.classList.add('iig-generated-image');
            wrapImageWithRegenBtn(img, messageId, idx);
        });
    };

    const observer = new MutationObserver(() => {
        if (pending) clearTimeout(pending);
        pending = setTimeout(flush, 80);
    });
    observer.observe(chat, { childList: true, subtree: true });
    flush();
    iigLog('INFO', 'Regen observer started on #chat');
}

// sillyimages обрабатывает те же теги: если оно включено вместе с vish,
// каждая картинка генерируется дважды.
async function warnIfSillyimagesActive() {
    const disabled = SillyTavern.getContext().extensionSettings?.disabledExtensions || [];
    if (disabled.includes('third-party/sillyimages')) return;
    try {
        const response = await fetch('/scripts/extensions/third-party/sillyimages/manifest.json', { method: 'HEAD' });
        if (!response.ok) return;
    } catch (e) { return; }
    toastr.warning('Включены и Chamber of Secrets, и sillyimages — картинки будут генерироваться дважды. Отключи sillyimages в Extensions.',
        'Chamber of Secrets', { timeOut: 0, extendedTimeOut: 0 });
}

/* ── Init ── */
(function init() {
    const context = SillyTavern.getContext();
    iigLog('INFO', 'Initializing IIG + Wardrobe v2.1.0');
    iigLog('INFO', `Platform: ${IS_IOS ? 'iOS' : 'Desktop'}, Timeout: ${FETCH_TIMEOUT/1000}s`);
    getSettings();

    context.eventSource.on(context.event_types.APP_READY, () => {
        warnIfSillyimagesActive();
        restoreRefsFromLocalStorage();
        createSettingsUI();
        addButtonsToExistingMessages();
        initLightbox();
        updateHeaderStatusDot();
        initMobileSaveListeners();
        initRegenObserver();
        setTimeout(() => { if (window.sillyWardrobe?.refreshDisplay) window.sillyWardrobe.refreshDisplay(); }, 500);
        iigLog('INFO', 'IIG + Wardrobe extension loaded');
    });

    context.eventSource.on(context.event_types.CHAT_CHANGED, () => {
        setTimeout(() => {
            restoreRefsFromLocalStorage();
            addButtonsToExistingMessages();
            renderRefSlots();
            if (window.sillyWardrobe?.refreshDisplay) window.sillyWardrobe.refreshDisplay();
        }, 300);
    });

    const handleMessage = async (messageId) => {
        iigLog('INFO', `Event: message ${messageId}`);
        await onMessageReceived(messageId);
    };

    context.eventSource.makeLast(context.event_types.CHARACTER_MESSAGE_RENDERED, handleMessage);
    iigLog('INFO', 'IIG + Wardrobe initialized');
})();


/* ╔═══════════════════════════════════════════════════════════════╗
   ║  MODULE 3 — Unified Гардероб & НПС Panel + Sendbar Button    ║
   ╚═══════════════════════════════════════════════════════════════╝ */
(function initVWPanel() {
    'use strict';

    const COSMETICS_SVG = `<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor"><path d="M475.415,117.769l3.126-73.358c0.499-11.705-3.689-22.808-11.796-31.267C458.64,4.686,447.725,0.028,436.01,0.028c-11.715,0-22.631,4.659-30.737,13.117c-8.105,8.458-12.294,19.562-11.796,31.266l3.127,73.358H0v49.198h512v-49.198H475.415z M441.997,117.769h-11.975l-3.187-74.779c-0.146-3.407,1.531-5.687,2.544-6.744c1.013-1.057,3.222-2.83,6.631-2.83c3.409,0,5.617,1.773,6.63,2.829s2.69,3.338,2.544,6.745L441.997,117.769z"/><path d="M475.835,200.355H36.143L17.239,427.204c-3.803,45.632,32.208,84.768,77.997,84.768h321.505c45.79,0,81.799-39.136,77.998-84.768L475.835,200.355z M323.025,300.149c18.263-3.73,33.47-2.522,33.47-2.522s3.923,48.917-23.829,76.668c-7.782,7.782-17.227,13.072-26.791,16.657c10.96-16.661,20.875-38.693,20.875-63.89C326.75,317.605,325.349,308.598,323.025,300.149z M155.504,297.627c0,0,15.208-1.209,33.47,2.522c-2.324,8.448-3.725,17.456-3.725,26.913c0,25.199,9.914,47.23,20.875,63.89c-9.564-3.586-19.011-8.877-26.791-16.657C151.581,346.544,155.504,297.627,155.504,297.627z M184.938,435.486c-39.246,0-71.062-37.363-71.062-37.363s9.899-11.608,25.45-21.884c4.33,7.617,9.709,14.978,16.397,21.664c13.691,13.69,31.657,23.41,53.398,28.889c2.229,0.562,4.429,1.056,6.599,1.501C206.407,432.536,195.966,435.486,184.938,435.486z M256,398.123c0,0-37.364-31.815-37.364-71.062S256,255.999,256,255.999s37.364,31.815,37.364,71.062S256,398.123,256,398.123z M327.061,435.486c-11.028,0-21.469-2.95-30.782-7.193c2.169-0.445,4.37-0.939,6.598-1.501c21.742-5.479,39.708-15.198,53.398-28.889c6.686-6.686,12.065-14.047,16.397-21.664c15.552,10.276,25.45,21.884,25.45,21.884S366.308,435.486,327.061,435.486z"/></svg>`;

    let vwOpen = false;
    let vwMainTab = 'wardrobe';   // 'wardrobe' | 'npc' | 'catalog' | 'settings'

    // Общий каталог вещей (его пополняет бот). Публичный репо, читается без токена.
    const VW_CATALOG_BASE = 'https://raw.githubusercontent.com/aurel11a/777777/main/';
    const vwCatalog = { index: null, loading: false, error: '', loadedAt: 0 };
    let vwCatalogFilter = 'all';
    let vwCatalogQuery = '';
    let vwCatalogPage = 0;
    const vwCatalogBusy = new Set(); // `${target}:${itemId}` — идёт импорт
    let vwCatalogSheetId = null;     // вещь, для которой открыт выбор «куда»
    // Женский / мужской каталог. Унисекс и вещи без пола видны в обоих. Выбор помнится в браузере.
    const VW_CATALOG_GENDER_KEY = 'vw_catalog_gender';
    let vwCatalogGender = (() => { try { return localStorage.getItem(VW_CATALOG_GENDER_KEY) === 'male' ? 'male' : 'female'; } catch (e) { return 'female'; } })();
    const vwInGenderCatalog = (it) => !it.gender || it.gender === 'unisex' || it.gender === vwCatalogGender;
    // Если в index.json нет списка категорий (старый каталог) — этот же список, что у бота.
    const VW_CATALOG_DEFAULT_CATEGORIES = [
        { id: 'casual', label: 'Повседневное', icon: 'fa-shirt' },
        { id: 'home', label: 'Домашнее', icon: 'fa-house' },
        { id: 'formal', label: 'Формальное', icon: 'fa-gem' },
        { id: 'sport', label: 'Спортивное', icon: 'fa-person-running' },
        { id: 'sleep', label: 'Спальное', icon: 'fa-bed' },
        { id: 'underwear', label: 'Бельё', icon: 'fa-heart' },
        { id: 'work', label: 'Работа', icon: 'fa-briefcase' },
        { id: 'beach', label: 'Пляжное', icon: 'fa-umbrella-beach' },
        { id: 'outer', label: 'Верхняя', icon: 'fa-mitten' },
        { id: 'vintage', label: 'Винтаж', icon: 'fa-record-vinyl' },
        { id: 'historical', label: 'Исторические', icon: 'fa-chess-queen' },
        { id: 'fantasy', label: 'Фэнтези', icon: 'fa-wand-magic-sparkles' },
        { id: 'wedding', label: 'Свадебные', icon: 'fa-ring' },
        { id: 'other', label: 'Другое', icon: 'fa-tag' },
    ];
    let vwSubTab   = 'bot';       // 'bot' | 'user'
    let vwView     = 'grid';      // 'grid' | 'list'
    let vwNpcView  = 'grid';
    let vwFilter   = 'all';       // фильтр по типу одежды (UI-состояние)
    let vwSort     = 'added';     // сортировка: 'added' | 'worn' | 'name'
    let vwPage     = 0;           // текущая страница пагинации
    const VW_PAGE_SIZE = 12;      // нарядов на страницу

    // Сортировка списка (новый массив; активный образ всегда выносим первым).
    function vwSortOutfits(arr, activeId) {
        const a = arr.slice();
        if (vwSort === 'name') a.sort((x, y) => (x.name || '').localeCompare(y.name || '', undefined, { sensitivity: 'base', numeric: true }));
        else if (vwSort === 'worn') a.sort((x, y) => (y.lastWorn || 0) - (x.lastWorn || 0) || (y.addedAt || 0) - (x.addedAt || 0));
        else a.sort((x, y) => (y.addedAt || 0) - (x.addedAt || 0));
        if (activeId) { const i = a.findIndex(o => o.id === activeId); if (i > 0) a.unshift(a.splice(i, 1)[0]); }
        return a;
    }

    /* ── helpers ── */

    // Мост к ядру гардероба (Module 1). До его готовности — безопасные заглушки.
    function swc() { return window._swCore || null; }
    // Текущий «вид» для активного таба (общий ИЛИ персональный).
    function vwCurView() {
        const core = swc();
        if (core?.viewForSide) return core.viewForSide(vwSubTab);
        // Фолбэк (ядро не загрузилось): персональный гардероб напрямую.
        const cn = vwCharName();
        return {
            shared: false, side: vwSubTab,
            list: () => vwOutfits(cn),
            activeId: () => vwActiveId(cn),
            setActive: (id) => { const d = vwWardrobeData(); if (!d.activeOutfits[cn]) d.activeOutfits[cn] = { bot: null, user: null }; d.activeOutfits[cn][vwSubTab] = id; vwSave(); return true; },
            find: (id) => vwOutfits(cn).find(o => o.id === id) || null,
            add: (o) => { const d = vwWardrobeData(); if (!d.wardrobes[cn]) d.wardrobes[cn] = { bot: [], user: [] }; d.wardrobes[cn][vwSubTab].push(o); vwSave(); },
            remove: (id) => { const d = vwWardrobeData(); const arr = d.wardrobes?.[cn]?.[vwSubTab]; if (arr) { const i = arr.findIndex(o => o.id === id); if (i !== -1) arr.splice(i, 1); } vwSave(); },
        };
    }
    function vwTypeOf(o) { return swc()?.typeOf ? swc().typeOf(o) : ((o && o.type) || 'other'); }
    function vwImgSrc(o) { return swc()?.imgSrc ? swc().imgSrc(o) : (o?.imagePath || (o?.base64 ? 'data:image/jpeg;base64,' + o.base64 : '')); }
    function vwTypes() { const c = swc(); return c?.types ? c.types() : []; }

    function san(text) {
        const d = document.createElement('div');
        d.textContent = text || '';
        return d.innerHTML;
    }

    function vwCharName() {
        const ctx = SillyTavern.getContext();
        if (ctx.characterId !== undefined && ctx.characters?.[ctx.characterId])
            return ctx.characters[ctx.characterId].name || '';
        return '';
    }

    function vwWardrobeData() {
        const ctx = SillyTavern.getContext();
        const s = ctx.extensionSettings['silly_wardrobe'];
        return s || { wardrobes: {}, activeOutfits: {} };
    }

    function vwIIGData() {
        const ctx = SillyTavern.getContext();
        const s = ctx.extensionSettings[MODULE_NAME];
        if (!s) return { npcReferences: [] };
        // Merge localStorage backup if settings refs are empty but backup has data
        if ((!s.npcReferences || s.npcReferences.length === 0)) {
            try {
                const raw = localStorage.getItem('iig_npc_refs_v3');
                if (raw) {
                    const backup = JSON.parse(raw);
                    if (Array.isArray(backup) && backup.length > 0) s.npcReferences = backup;
                    else if (backup && typeof backup === 'object') {
                        // older format might be an object
                        const arr = Object.values(backup).filter(v => v && v.name);
                        if (arr.length > 0) s.npcReferences = arr;
                    }
                }
            } catch(e) {}
        }
        if (!Array.isArray(s.npcReferences)) s.npcReferences = [];
        return s;
    }

    function vwSave() { SillyTavern.getContext().saveSettingsDebounced(); }

    // Sync settings drawer after every panel change
    function vwSaveAndSync() {
        vwSave();
        if (typeof renderNpcList === 'function') renderNpcList();
        if (typeof refreshWardrobeSettingsDisplay === 'function') refreshWardrobeSettingsDisplay();
    }

    // Called from settings drawer — re-render open panel to stay in sync
    function vwSyncFromSettings() {
        vwRefreshBtn();
        if (!vwOpen) return;
        const panel = document.getElementById('vw-panel');
        if (panel) vwRenderBody(panel);
    }
    // Make accessible to settings drawer code (Module 2 scope)
    window._vwSyncFromSettings = vwSyncFromSettings;

    // Expose open function for Module 4 (Quick Settings double-tap)
    window._vwOpenPanel = vwOpenPanel;

    function vwOutfits(cn) {
        const d = vwWardrobeData();
        if (!d.wardrobes[cn]) d.wardrobes[cn] = { bot: [], user: [] };
        return d.wardrobes[cn][vwSubTab] || [];
    }

    function vwActiveId(cn) {
        const d = vwWardrobeData();
        if (!d.activeOutfits[cn]) d.activeOutfits[cn] = { bot: null, user: null };
        return d.activeOutfits[cn][vwSubTab];
    }

    /* ── Bar Button ── */

    function vwInjectBtn() {
        let btn = document.getElementById('vw-panel-btn');
        if (!btn) {
            btn = document.createElement('div');
            btn.id = 'vw-panel-btn';
            btn.title = 'Гардероб & НПС';
            btn.innerHTML = COSMETICS_SVG;

            let _touchHandled = false;

            btn.addEventListener('touchstart', () => { _touchHandled = false; }, { passive: true });
            btn.addEventListener('touchend', (e) => {
                e.preventDefault();
                e.stopPropagation();
                _touchHandled = true;
                vwOpen ? vwClose() : vwOpenPanel();
            });
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (_touchHandled) { _touchHandled = false; return; } // skip — already handled by touchend
                vwOpen ? vwClose() : vwOpenPanel();
            });
        }

        // Try #leftSendForm first, then common ST fallbacks
        const containers = [
            document.getElementById('leftSendForm'),
            document.getElementById('send_form'),
            document.querySelector('#leftSendForm'),
            document.querySelector('.form_sheld'),
        ];
        const left = containers.find(c => c);
        if (left && !left.contains(btn)) {
            left.appendChild(btn);
        } else if (!left && !document.body.contains(btn)) {
            document.body.appendChild(btn);
        }
        vwRefreshBtn();
    }

    function vwRefreshBtn() {
        const btn = document.getElementById('vw-panel-btn');
        if (!btn) return;
        const core = swc();
        let hasW;
        if (core?.activeSideOutfit) {
            // Учитываем и общий, и персональный гардероб.
            hasW = !!(core.activeSideOutfit('bot') || core.activeSideOutfit('user'));
        } else {
            const active = vwWardrobeData().activeOutfits?.[vwCharName()];
            hasW = !!(active?.bot || active?.user);
        }
        const npcs = vwIIGData().npcReferences || [];
        const hasN = npcs.some(n => n.enabled !== false && (n.imageBase64 || n.imageData || n.imagePath));
        btn.classList.toggle('vw-btn-active', hasW || hasN);
    }

    /* ── Panel open / close ── */

    function vwOpenPanel() {
        vwClose();
        vwOpen = true;

        const ov = document.createElement('div');
        ov.id = 'vw-overlay';
        ov.addEventListener('click', (e) => { if (e.target === ov) vwClose(); });

        const panel = document.createElement('div');
        panel.id = 'vw-panel';
        ov.appendChild(panel);

        document.documentElement.appendChild(ov);

        /* swipe-down to close */
        let sy = 0, dy = 0, sw = false;
        panel.addEventListener('touchstart', (e) => {
            if (!panel.querySelector('.vw-header')?.contains(e.target)) return;
            sy = e.touches[0].clientY; dy = 0; sw = true;
        }, { passive: true });
        panel.addEventListener('touchmove', (e) => {
            if (!sw) return; dy = e.touches[0].clientY - sy;
            if (dy > 0) { panel.style.transform = `translateY(${Math.sqrt(dy) * 5}px)`; panel.style.transition = 'none'; }
        }, { passive: true });
        panel.addEventListener('touchend', () => {
            if (!sw) return; sw = false;
            panel.style.transform = ''; panel.style.transition = '';
            if (dy > 80) { panel.style.transition = 'transform .25s ease'; panel.style.transform = 'translateY(110%)'; ov.style.transition = 'opacity .25s ease'; ov.style.opacity = '0'; setTimeout(vwClose, 240); }
        }, { passive: true });

        document.addEventListener('keydown', vwEsc);
        vwBuild(panel);
    }

    function vwClose() {
        vwOpen = false;
        vwCatalogSheetId = null;
        document.querySelector('.vw-sheet-backdrop')?.remove();
        const ov = document.getElementById('vw-overlay');
        ov?.remove();
        document.removeEventListener('keydown', vwEsc);
        vwRefreshBtn();
    }

    function vwEsc(e) { if (e.key === 'Escape') vwClose(); }

    /* ── Build panel ── */

    function vwBuild(panel) {
        const isW = vwMainTab === 'wardrobe';
        const isS = vwMainTab === 'settings';
        const isN = vwMainTab === 'npc';
        const isC = vwMainTab === 'catalog';
        const curView = isW ? vwView : vwNpcView;

        panel.innerHTML = `
        <div class="vw-header">
            <div class="vw-main-tabs">
                <button class="vw-mtab ${isW ? 'vw-active' : ''}" data-tab="wardrobe">
                    <i class="fa-solid fa-shirt"></i><span>Гардероб</span>
                </button>
                <button class="vw-mtab ${isN ? 'vw-active' : ''}" data-tab="npc">
                    <i class="fa-solid fa-users"></i><span>НПС</span>
                </button>
                <button class="vw-mtab ${isC ? 'vw-active' : ''}" data-tab="catalog">
                    <i class="fa-solid fa-store"></i><span>Каталог</span>
                </button>
                <button class="vw-mtab ${isS ? 'vw-active' : ''}" data-tab="settings">
                    <i class="fa-solid fa-sliders"></i><span>Настройки</span>
                </button>
            </div>
            <div class="vw-header-right">
                ${isW ? `<button class="vw-view-btn vw-cleanup-trigger" title="Обслуживание: дубликаты и чистка файлов"><i class="fa-solid fa-broom"></i></button>` : ''}
                ${!isS && !isC ? `
                <button class="vw-view-btn ${curView === 'grid' ? 'vw-active' : ''}" data-view="grid" title="Сетка"><i class="fa-solid fa-grip"></i></button>
                <button class="vw-view-btn ${curView === 'list' ? 'vw-active' : ''}" data-view="list" title="Список"><i class="fa-solid fa-list"></i></button>
                ` : ''}
                <button class="vw-close-btn" title="Закрыть"><i class="fa-solid fa-xmark"></i></button>
            </div>
        </div>
        <div class="vw-body" id="vw-body"></div>
        ${isW ? `
        <div class="vw-footer">
            <div class="vw-sub-tabs">
                <button class="vw-stab ${vwSubTab === 'bot' ? 'vw-active' : ''}" data-sub="bot"><i class="fa-solid fa-robot"></i> Чар</button>
                <button class="vw-stab ${vwSubTab === 'user' ? 'vw-active' : ''}" data-sub="user"><i class="fa-solid fa-user"></i> Юзер</button>
            </div>
            <label class="vw-upload-label" title="Загрузить аутфит" id="vw-upload-label">
                <i class="fa-solid fa-plus"></i> Добавить
                <input type="file" accept="image/*" style="display:none" id="vw-file-input">
            </label>
        </div>` : isN ? `
        <div class="vw-footer vw-npc-footer">
            <div class="vw-npc-add-row">
                <input type="text" class="text_pole vw-npc-inp" id="vw-npc-inp" placeholder="Имя НПС...">
                <button class="vw-add-npc-btn" id="vw-add-npc"><i class="fa-solid fa-plus"></i> Добавить</button>
            </div>
        </div>` : ''}`;

        /* header events */
        for (const t of panel.querySelectorAll('.vw-mtab'))
            t.addEventListener('click', () => { vwMainTab = t.dataset.tab; vwBuild(panel); });

        // Только настоящие переключатели вида (grid/list). Кнопка-«метла» тоже носит класс
        // vw-view-btn ради единого стиля, но data-view у неё нет — её сюда пускать нельзя,
        // иначе клик по чистке обнулял бы vwView и сетка «сама» превращалась в список.
        for (const v of panel.querySelectorAll('.vw-view-btn[data-view]'))
            v.addEventListener('click', () => {
                if (vwMainTab === 'wardrobe') vwView = v.dataset.view; else vwNpcView = v.dataset.view;
                vwBuild(panel);
            });

        panel.querySelector('.vw-close-btn').addEventListener('click', vwClose);
        panel.querySelector('.vw-cleanup-trigger')?.addEventListener('click', () => vwOpenMaintenance('dedup'));

        if (isW) {
            for (const st of panel.querySelectorAll('.vw-stab'))
                st.addEventListener('click', () => {
                    vwSubTab = st.dataset.sub;
                    vwFilter = 'all'; vwPage = 0; // у каждого таба свой режим/фильтр — сбрасываем
                    for (const x of panel.querySelectorAll('.vw-stab')) x.classList.toggle('vw-active', x.dataset.sub === vwSubTab);
                    vwRenderBody(panel);
                });

            panel.querySelector('#vw-file-input')?.addEventListener('change', (e) => vwUpload(e, panel));
        } else if (isN) {
            panel.querySelector('#vw-add-npc')?.addEventListener('click', () => vwAddNpc(panel));
            panel.querySelector('#vw-npc-inp')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') vwAddNpc(panel); });
        }

        vwRenderBody(panel);
    }

    function vwRenderBody(panel) {
        const body = document.getElementById('vw-body');
        if (!body) return;
        if (vwMainTab !== 'catalog') { vwCatalogSheetId = null; document.querySelector('.vw-sheet-backdrop')?.remove(); }
        if (vwMainTab === 'wardrobe') vwRenderWardrobe(body, panel);
        else if (vwMainTab === 'npc') vwRenderNpc(body, panel);
        else if (vwMainTab === 'catalog') vwRenderCatalog(body, panel);
        else if (vwMainTab === 'settings') {
            body.innerHTML = '';
            if (typeof window._qsBuildSettingsContent === 'function') {
                window._qsBuildSettingsContent(body);
            } else {
                body.innerHTML = '<p style="opacity:0.5;padding:16px;font-size:0.85em;">Настройки загружаются...</p>';
            }
        }
    }

    /* ── Wardrobe ── */

    function vwRenderWardrobe(body, panel) {
        const view = vwCurView();
        const cn = vwCharName();
        const noChar = !view.shared && !cn; // персональный режим требует персонажа; общий — нет

        const outfits = noChar ? [] : (view.list() || []);
        const activeId = noChar ? null : view.activeId();

        // Счётчики по типам (для фильтр-чипов)
        const counts = {};
        for (const o of outfits) { const t = vwTypeOf(o); counts[t] = (counts[t] || 0) + 1; }
        if (vwFilter !== 'all' && !counts[vwFilter]) vwFilter = 'all';
        const filtered = vwFilter === 'all' ? outfits : outfits.filter(o => vwTypeOf(o) === vwFilter);
        const shown = vwSortOutfits(filtered, activeId);

        // Пагинация — рендерим только текущую страницу (меньше DOM-узлов и одновременных загрузок)
        const totalPages = Math.max(1, Math.ceil(shown.length / VW_PAGE_SIZE));
        if (vwPage > totalPages - 1) vwPage = totalPages - 1;
        if (vwPage < 0) vwPage = 0;
        const pageItems = shown.slice(vwPage * VW_PAGE_SIZE, (vwPage + 1) * VW_PAGE_SIZE);

        let html = vwModeRowHtml(view) + vwFilterRowHtml(counts, outfits.length);
        const types = vwTypes();
        const typeMeta = (o) => (swc()?.typeMeta ? swc().typeMeta(vwTypeOf(o)) : { icon: 'fa-tag', label: 'Другое' });
        const typeOpts = (o) => types.map(t => `<option value="${t.id}" ${vwTypeOf(o) === t.id ? 'selected' : ''}>${san(t.label)}</option>`).join('');

        if (noChar) {
            html += `<div class="vw-empty"><i class="fa-solid fa-user-slash"></i><p>Выберите персонажа<br><small>или включите «Общий» гардероб</small></p></div>`;
        } else if (outfits.length === 0) {
            html += `<div class="vw-empty"><i class="fa-solid fa-shirt"></i><p>${view.shared ? 'Общий гардероб пуст' : 'Аутфитов нет'}<br><small>Нажмите «Добавить»</small></p></div>`;
        } else if (vwView === 'grid') {
            html += '<div class="vw-outfit-grid">';
            for (const o of pageItems) {
                const on = o.id === activeId; const tm = typeMeta(o);
                html += `<div class="vw-card ${on ? 'vw-on' : ''}" data-id="${o.id}">
                    <div class="vw-card-img-wrap">
                        <img src="${san(vwImgSrc(o))}" class="vw-card-img" alt="${san(o.name)}" loading="lazy">
                        ${on ? '<div class="vw-badge"><i class="fa-solid fa-check"></i></div>' : ''}
                        <div class="vw-type-badge" title="${san(tm.label)}"><i class="fa-solid ${tm.icon}"></i></div>
                    </div>
                    <div class="vw-card-foot">
                        <span class="vw-card-name" title="${san(o.description || o.name)}">${san(o.name)}</span>
                        <div class="vw-card-btns">
                            <button class="vw-ic-btn vw-tog" data-id="${o.id}" title="${on ? 'Снять' : 'Надеть'}"><i class="fa-solid ${on ? 'fa-toggle-on vw-green' : 'fa-toggle-off'}"></i></button>
                            <button class="vw-ic-btn vw-edt" data-id="${o.id}" title="Редактировать"><i class="fa-solid fa-pen"></i></button>
                            <button class="vw-ic-btn vw-del" data-id="${o.id}" title="Удалить"><i class="fa-solid fa-trash-can"></i></button>
                        </div>
                    </div>
                    <select class="vw-type-select" data-id="${o.id}" title="Тип одежды">${typeOpts(o)}</select>
                </div>`;
            }
            html += '</div>';
        } else {
            html += '<div class="vw-list">';
            for (const o of pageItems) {
                const on = o.id === activeId; const tm = typeMeta(o);
                html += `<div class="vw-row ${on ? 'vw-on' : ''}" data-id="${o.id}">
                    <img src="${san(vwImgSrc(o))}" class="vw-row-thumb" alt="${san(o.name)}" loading="lazy">
                    <div class="vw-row-info">
                        <span class="vw-row-name"><i class="fa-solid ${tm.icon} vw-row-type" title="${san(tm.label)}"></i> ${san(o.name)}</span>
                        ${o.description ? `<span class="vw-row-desc">${san(o.description)}</span>` : ''}
                    </div>
                    <div class="vw-row-btns">
                        <button class="vw-ic-btn vw-tog" data-id="${o.id}" title="${on ? 'Снять' : 'Надеть'}"><i class="fa-solid ${on ? 'fa-toggle-on vw-green' : 'fa-toggle-off'}"></i></button>
                        <button class="vw-ic-btn vw-edt" data-id="${o.id}" title="Редактировать"><i class="fa-solid fa-pen"></i></button>
                        <button class="vw-ic-btn vw-del" data-id="${o.id}" title="Удалить"><i class="fa-solid fa-trash-can"></i></button>
                    </div>
                </div>`;
            }
            html += '</div>';
        }

        // Пагинатор
        if (!noChar && totalPages > 1) {
            html += `<div class="vw-pager">
                <button class="vw-pager-btn ${vwPage === 0 ? 'vw-pager-dim' : ''}" data-pg="prev" title="Назад"><i class="fa-solid fa-chevron-left"></i></button>
                <span class="vw-pager-info">Стр. ${vwPage + 1} / ${totalPages} <small>(${shown.length})</small></span>
                <button class="vw-pager-btn ${vwPage >= totalPages - 1 ? 'vw-pager-dim' : ''}" data-pg="next" title="Вперёд"><i class="fa-solid fa-chevron-right"></i></button>
            </div>`;
        }

        body.innerHTML = html;
        vwBindModeFilter(body, panel);

        for (const b of body.querySelectorAll('.vw-pager-btn'))
            b.addEventListener('click', () => {
                if (b.dataset.pg === 'prev' && vwPage > 0) { vwPage--; vwRenderBody(panel); }
                else if (b.dataset.pg === 'next' && vwPage < totalPages - 1) { vwPage++; vwRenderBody(panel); }
            });

        /* card events */
        for (const b of body.querySelectorAll('.vw-tog'))
            b.addEventListener('click', (e) => { e.stopPropagation(); vwToggle(b.dataset.id, panel); });
        for (const b of body.querySelectorAll('.vw-edt'))
            b.addEventListener('click', (e) => { e.stopPropagation(); vwEdit(b.dataset.id, panel); });
        for (const b of body.querySelectorAll('.vw-del'))
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                const v = vwCurView();
                const msg = v.shared
                    ? 'Удалить образ из общего гардероба?\n\nКартинка тоже удалится с сервера — без возврата.'
                    : 'Удалить аутфит?';
                if (!confirm(msg)) return;
                v.remove(b.dataset.id);
                if (v.shared && swc()?.preloadSharedActive) swc().preloadSharedActive(v.side);
                if (window.sillyWardrobe?.updatePromptInjection) window.sillyWardrobe.updatePromptInjection();
                vwSaveAndSync();
                vwRenderBody(panel); vwRefreshBtn();
                toastr.info(v.shared ? 'Образ и файл удалены' : 'Аутфит удалён', 'Гардероб', { timeOut: 2000 });
            });
        for (const sel of body.querySelectorAll('.vw-type-select'))
            sel.addEventListener('change', (e) => {
                e.stopPropagation();
                const v = vwCurView();
                const o = v.find(sel.dataset.id);
                if (o) { o.type = e.target.value; vwSaveAndSync(); vwRenderBody(panel); }
            });
    }

    /* ── Каталог ── */

    async function vwLoadCatalog(panel, force = false) {
        if (vwCatalog.loading) return;
        // raw.githubusercontent кэширует файл ~5 минут; метка времени в адресе обходит кэш.
        if (!force && vwCatalog.index && Date.now() - vwCatalog.loadedAt < 60_000) return;
        vwCatalog.loading = true; vwCatalog.error = '';
        if (vwMainTab === 'catalog') vwRenderBody(panel);
        try {
            const resp = await fetch(`${VW_CATALOG_BASE}index.json?t=${Date.now()}`, { cache: 'no-store' });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const index = await resp.json();
            vwCatalog.index = { ...index, items: Array.isArray(index.items) ? index.items : [] };
            vwCatalog.loadedAt = Date.now();
        } catch (e) {
            vwCatalog.error = e.message || String(e);
        } finally {
            vwCatalog.loading = false;
            if (vwMainTab === 'catalog') vwRenderBody(panel);
        }
    }

    // Какие вещи каталога уже лежат в гардеробе стороны (по catalogId).
    function vwImportedIds(side) {
        const ids = new Set();
        try {
            const view = swc()?.viewForSide ? swc().viewForSide(side) : null;
            for (const o of (view?.list?.() || [])) if (o?.catalogId) ids.add(o.catalogId);
        } catch (e) { /* персональный режим без персонажа */ }
        return ids;
    }

    function vwCatalogCategories() {
        const fromIndex = vwCatalog.index?.categories;
        const valid = Array.isArray(fromIndex) && fromIndex.filter(c => c && typeof c.id === 'string' && c.id);
        return valid && valid.length ? valid : VW_CATALOG_DEFAULT_CATEGORIES;
    }
    function vwCatalogCategory(item) {
        const cats = vwCatalogCategories();
        return cats.find(c => c.id === item?.type) || cats.find(c => c.id === 'other') || { id: 'other', label: 'Другое', icon: 'fa-tag' };
    }
    function vwCatalogTypeOf(item) { return vwCatalogCategory(item).id; }

    // НПС, на которых сейчас надета эта вещь каталога.
    function vwNpcsWearing(itemId) {
        return (vwIIGData().npcReferences || []).filter(n => n?.outfit?.catalogId === itemId);
    }

    function vwRenderCatalog(body, panel) {
        if (!vwCatalog.index && !vwCatalog.loading && !vwCatalog.error) { vwLoadCatalog(panel); return; }

        const items = (vwCatalog.index?.items || []).slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
        const pool = items.filter(vwInGenderCatalog);
        const query = vwCatalogQuery.trim().toLowerCase();
        const counts = {};
        for (const it of pool) { const t = vwCatalogTypeOf(it); counts[t] = (counts[t] || 0) + 1; }
        if (vwCatalogFilter !== 'all' && !counts[vwCatalogFilter]) vwCatalogFilter = 'all';
        const shown = pool.filter(it =>
            (vwCatalogFilter === 'all' || vwCatalogTypeOf(it) === vwCatalogFilter) &&
            (!query || `${it.name || ''} ${it.description || ''}`.toLowerCase().includes(query)));
        const totalPages = Math.max(1, Math.ceil(shown.length / VW_PAGE_SIZE));
        vwCatalogPage = Math.min(Math.max(vwCatalogPage, 0), totalPages - 1);
        const pageItems = shown.slice(vwCatalogPage * VW_PAGE_SIZE, (vwCatalogPage + 1) * VW_PAGE_SIZE);
        const imported = { bot: vwImportedIds('bot'), user: vwImportedIds('user') };

        const genderBtn = (g, icon, label) => `<button class="vw-mode-btn vw-catalog-gender ${vwCatalogGender === g ? 'vw-mode-on' : ''}" data-gender="${g}"><i class="fa-solid ${icon}"></i> ${label}</button>`;
        let html = `<div class="vw-mode-row">${genderBtn('female', 'fa-person-dress', 'Женское')}${genderBtn('male', 'fa-person', 'Мужское')}</div>
        <div class="vw-mode-row vw-catalog-bar">
            <input type="search" class="text_pole vw-catalog-search" placeholder="Поиск по каталогу" value="${san(vwCatalogQuery)}">
            <button class="vw-mode-btn vw-catalog-refresh" title="Обновить каталог"><i class="fa-solid fa-rotate ${vwCatalog.loading ? 'fa-spin' : ''}"></i></button>
        </div>`;

        if (pool.length) {
            html += `<div class="vw-filter-row"><button class="vw-filter-chip ${vwCatalogFilter === 'all' ? 'vw-filter-on' : ''}" data-ctype="all">Все <span class="vw-chip-count">${pool.length}</span></button>`;
            for (const t of vwCatalogCategories()) {
                if (!counts[t.id]) continue;
                html += `<button class="vw-filter-chip ${vwCatalogFilter === t.id ? 'vw-filter-on' : ''}" data-ctype="${san(t.id)}"><i class="fa-solid ${san(t.icon || 'fa-tag')}"></i> ${san(t.label || t.id)} <span class="vw-chip-count">${counts[t.id]}</span></button>`;
            }
            html += '</div>';
        }

        if (vwCatalog.error && !items.length) {
            html += `<div class="vw-empty"><i class="fa-solid fa-cloud-bolt"></i><p>Не удалось загрузить каталог<br><small>${san(vwCatalog.error)}</small></p></div>`;
        } else if (vwCatalog.loading && !items.length) {
            html += `<div class="vw-empty"><i class="fa-solid fa-spinner fa-spin"></i><p>Загружаю каталог…</p></div>`;
        } else if (!items.length) {
            html += `<div class="vw-empty"><i class="fa-solid fa-store"></i><p>Каталог пока пуст<br><small>Вещи добавляются через бота</small></p></div>`;
        } else if (!pool.length) {
            html += `<div class="vw-empty"><i class="fa-solid fa-store"></i><p>В ${vwCatalogGender === 'male' ? 'мужском' : 'женском'} каталоге пока пусто</p></div>`;
        } else if (!shown.length) {
            html += `<div class="vw-empty"><i class="fa-solid fa-magnifying-glass"></i><p>Ничего не найдено</p></div>`;
        } else {
            html += '<div class="vw-outfit-grid">';
            for (const it of pageItems) {
                const cat = vwCatalogCategory(it);
                const marks = [];
                if (imported.user.has(it.id)) marks.push('<span title="В гардеробе Юзера"><i class="fa-solid fa-user"></i></span>');
                if (imported.bot.has(it.id)) marks.push('<span title="В гардеробе персонажа"><i class="fa-solid fa-robot"></i></span>');
                for (const n of vwNpcsWearing(it.id)) marks.push(`<span title="Надето на НПС">${san(n.name)}</span>`);
                const busy = [...vwCatalogBusy].some(k => k.endsWith(`:${it.id}`));
                html += `<div class="vw-card vw-catalog-card" data-id="${san(it.id)}">
                    <div class="vw-card-img-wrap">
                        <img src="${san(VW_CATALOG_BASE + (it.thumb || it.image || ''))}" class="vw-card-img" alt="${san(it.name)}" loading="lazy">
                        <div class="vw-type-badge" title="${san(cat.label)}"><i class="fa-solid ${san(cat.icon || 'fa-tag')}"></i></div>
                        ${marks.length ? `<div class="vw-catalog-marks">${marks.join('')}</div>` : ''}
                    </div>
                    <div class="vw-card-foot">
                        <span class="vw-card-name" title="${san(it.description || it.name)}">${san(it.name)}</span>
                    </div>
                    <div class="vw-catalog-actions">
                        <button class="vw-catalog-take" data-id="${san(it.id)}" ${busy ? 'disabled' : ''}>
                            <i class="fa-solid ${busy ? 'fa-spinner fa-spin' : 'fa-plus'}"></i> ${busy ? 'Добавляю…' : 'Добавить'}</button>
                    </div>
                </div>`;
            }
            html += '</div>';
            if (totalPages > 1) {
                html += `<div class="vw-pager">
                    <button class="vw-pager-btn ${vwCatalogPage === 0 ? 'vw-pager-dim' : ''}" data-cpg="prev" title="Назад"><i class="fa-solid fa-chevron-left"></i></button>
                    <span class="vw-pager-info">Стр. ${vwCatalogPage + 1} / ${totalPages} <small>(${shown.length})</small></span>
                    <button class="vw-pager-btn ${vwCatalogPage >= totalPages - 1 ? 'vw-pager-dim' : ''}" data-cpg="next" title="Вперёд"><i class="fa-solid fa-chevron-right"></i></button>
                </div>`;
            }
        }

        body.innerHTML = html;

        const search = body.querySelector('.vw-catalog-search');
        search?.addEventListener('input', (e) => {
            vwCatalogQuery = e.target.value; vwCatalogPage = 0;
            const pos = e.target.selectionStart;
            vwRenderBody(panel);
            const again = document.querySelector('#vw-body .vw-catalog-search');
            if (again) { again.focus(); again.setSelectionRange(pos, pos); }
        });
        body.querySelector('.vw-catalog-refresh')?.addEventListener('click', () => vwLoadCatalog(panel, true));
        for (const b of body.querySelectorAll('.vw-catalog-gender'))
            b.addEventListener('click', () => {
                vwCatalogGender = b.dataset.gender === 'male' ? 'male' : 'female';
                try { localStorage.setItem(VW_CATALOG_GENDER_KEY, vwCatalogGender); } catch (e) { /* приватный режим */ }
                vwCatalogFilter = 'all'; vwCatalogPage = 0;
                vwRenderBody(panel);
            });
        for (const chip of body.querySelectorAll('.vw-filter-chip[data-ctype]'))
            chip.addEventListener('click', () => { vwCatalogFilter = chip.dataset.ctype; vwCatalogPage = 0; vwRenderBody(panel); });
        const fr = body.querySelector('.vw-filter-row');
        if (fr) fr.addEventListener('wheel', (e) => { if (e.deltaY && !e.shiftKey) { fr.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
        for (const b of body.querySelectorAll('.vw-pager-btn[data-cpg]'))
            b.addEventListener('click', () => {
                if (b.dataset.cpg === 'prev' && vwCatalogPage > 0) vwCatalogPage--;
                else if (b.dataset.cpg === 'next' && vwCatalogPage < totalPages - 1) vwCatalogPage++;
                vwRenderBody(panel);
            });
        for (const b of body.querySelectorAll('.vw-catalog-take'))
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                vwCatalogSheetId = b.dataset.id;
                vwRenderBody(panel);
            });

        document.querySelector('.vw-sheet-backdrop')?.remove();
        const sheetItem = vwCatalogSheetId && items.find(it => it.id === vwCatalogSheetId);
        if (sheetItem) vwRenderCatalogSheet(body, panel, sheetItem, imported);
        else vwCatalogSheetId = null;

        // Каталог мог обновиться, пока панель была закрыта.
        if (vwCatalog.index && !vwCatalog.loading && !vwCatalog.error && Date.now() - vwCatalog.loadedAt > 5 * 60_000) vwLoadCatalog(panel);
    }

    // Картинка из каталога (WebP) → JPEG base64 без префикса, как остальные наряды.
    async function vwCatalogImageBase64(url, maxDim) {
        const resp = await fetch(url, { cache: 'no-store' });
        if (!resp.ok) throw new Error(`картинка не загрузилась (HTTP ${resp.status})`);
        const bitmap = await createImageBitmap(await resp.blob());
        const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(bitmap.width * scale);
        canvas.height = Math.round(bitmap.height * scale);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; // прозрачный фон → белый, JPEG без альфы
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close?.();
        return canvas.toDataURL('image/jpeg', 0.88).split(',')[1];
    }

    // Лист выбора: Юзер / персонаж — «В гардероб» или «Надеть»; НПС — «Надеть».
    function vwRenderCatalogSheet(body, panel, item, imported) {
        const cn = vwCharName();
        const sideRow = (side, icon, title) => {
            const view = swc()?.viewForSide ? swc().viewForSide(side) : null;
            const blocked = !view || (!view.shared && !cn);
            const where = view?.shared ? 'общий гардероб' : (side === 'bot' ? 'гардероб персонажа' : 'личный гардероб');
            const has = imported[side].has(item.id);
            return `<div class="vw-sheet-row">
                <div class="vw-sheet-who"><i class="fa-solid ${icon}"></i><div><b>${san(title)}</b><small>${blocked ? 'выбери персонажа или включи «Общий»' : where}${has ? ' · уже есть' : ''}</small></div></div>
                <div class="vw-sheet-btns">
                    <button class="vw-sheet-btn" data-target="${side}" data-wear="0" ${blocked ? 'disabled' : ''}><i class="fa-solid fa-box-archive"></i> В гардероб</button>
                    <button class="vw-sheet-btn vw-sheet-main" data-target="${side}" data-wear="1" ${blocked ? 'disabled' : ''}><i class="fa-solid fa-shirt"></i> Надеть</button>
                </div>
            </div>`;
        };
        const npcs = vwIIGData().npcReferences || [];
        const npcRows = npcs.length ? npcs.map((n, i) => {
            const wearingThis = n.outfit?.catalogId === item.id;
            return `<div class="vw-sheet-row">
                <div class="vw-sheet-who"><i class="fa-solid fa-user-group"></i><div><b>${san(n.name)}</b><small>${n.outfit ? `сейчас: ${san(n.outfit.name || 'наряд')}` : 'без наряда'}</small></div></div>
                <div class="vw-sheet-btns">
                    <button class="vw-sheet-btn vw-sheet-main" data-target="npc:${i}" data-wear="1" ${wearingThis ? 'disabled' : ''}><i class="fa-solid ${wearingThis ? 'fa-check' : 'fa-shirt'}"></i> ${wearingThis ? 'Надето' : 'Надеть'}</button>
                </div>
            </div>`;
        }).join('') : '<div class="vw-sheet-empty">НПС пока нет — их добавляют во вкладке «НПС»</div>';

        const sheet = document.createElement('div');
        sheet.className = 'vw-sheet-backdrop';
        sheet.innerHTML = `<div class="vw-sheet">
            <div class="vw-sheet-head">
                <img src="${san(VW_CATALOG_BASE + (item.thumb || item.image || ''))}" alt="">
                <div class="vw-sheet-title"><b>${san(item.name)}</b><small>${san(vwCatalogCategory(item).label)}</small>
                    ${item.description ? `<p>${san(item.description)}</p>` : ''}</div>
                <button class="vw-ic-btn vw-sheet-close" title="Закрыть"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="vw-sheet-section">Куда добавить</div>
            ${sideRow('user', 'fa-user', 'Юзер')}
            ${sideRow('bot', 'fa-robot', cn || 'Персонаж')}
            <div class="vw-sheet-section">НПС</div>
            ${npcRows}
        </div>`;
        // Рядом с панелью, на <html>: у body в ST position: fixed, и внутри него лист оказался бы под панелью.
        document.documentElement.appendChild(sheet);

        const close = () => { vwCatalogSheetId = null; sheet.remove(); vwRenderBody(panel); };
        sheet.addEventListener('click', (e) => { if (e.target === sheet) close(); });
        sheet.querySelector('.vw-sheet-close').addEventListener('click', close);
        for (const b of sheet.querySelectorAll('.vw-sheet-btn'))
            b.addEventListener('click', () => {
                vwCatalogSheetId = null;
                sheet.remove();
                vwImportCatalogItem(item, b.dataset.target, b.dataset.wear === '1', panel);
            });
    }

    async function vwImportCatalogItem(item, target, wear, panel) {
        const key = `${target}:${item.id}`;
        if (vwCatalogBusy.has(key)) return;
        const isNpc = target.startsWith('npc:');
        const view = !isNpc && swc()?.viewForSide ? swc().viewForSide(target) : null;
        if (!isNpc && !view) { toastr.error('Гардероб ещё не загрузился', 'Каталог'); return; }
        if (view && !view.shared && !vwCharName()) {
            toastr.warning('Выбери персонажа или включи «Общий» гардероб', 'Каталог');
            return;
        }
        vwCatalogBusy.add(key);
        vwRenderBody(panel);
        try {
            const base64 = await vwCatalogImageBase64(VW_CATALOG_BASE + item.image, swc()?.maxDim ? swc().maxDim() : 768);
            const cat = vwCatalogCategory(item);
            if (isNpc) {
                const npc = vwIIGData().npcReferences?.[+target.slice(4)];
                if (!npc) throw new Error('НПС не найден');
                const imagePath = swc()?.saveFile ? await swc().saveFile(base64, `npc_outfit_${npc.name}`) : '';
                if (!imagePath) throw new Error('не удалось сохранить картинку');
                npc.outfit = { name: item.name || 'Наряд', description: item.description || '', imagePath, catalogId: item.id, gender: item.gender || '' };
                vwSaveAndSync();
                toastr.success(`${npc.name} теперь в «${npc.outfit.name}»`, 'Каталог', { timeOut: 2500 });
            } else {
                const newItem = {
                    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
                    name: item.name || 'Без имени',
                    // категория каталога появляется среди тегов гардероба, если её не было
                    type: swc()?.ensureType ? swc().ensureType(cat) : cat.id,
                    description: item.description || '',
                    addedAt: Date.now(),
                    catalogId: item.id,
                    gender: item.gender || '',
                };
                if (view.shared && swc()?.saveFile) {
                    try { newItem.imagePath = await swc().saveFile(base64, (target === 'bot' ? 'sw_bot_' : 'sw_user_') + newItem.name); }
                    catch (err) { console.warn('[vw] catalog file store failed, fallback base64:', err.message); }
                }
                if (!newItem.imagePath) newItem.base64 = base64;
                view.add(newItem);
                if (wear) { newItem.lastWorn = Date.now(); view.setActive(newItem.id); }
                if (view.shared && swc()?.preloadSharedActive) swc().preloadSharedActive(target);
                vwSaveAndSync();
                vwRefreshBtn();
                const whoName = target === 'bot' ? (vwCharName() || 'персонажа') : 'Юзера';
                toastr.success(wear ? `«${newItem.name}» надето на ${whoName}` : `«${newItem.name}» в гардеробе ${target === 'bot' ? 'персонажа' : 'Юзера'}`,
                    'Каталог', { timeOut: 2500 });
            }
            if (window.sillyWardrobe?.updatePromptInjection) window.sillyWardrobe.updatePromptInjection();
        } catch (e) {
            toastr.error(`Не удалось добавить: ${e.message}`, 'Каталог');
        } finally {
            vwCatalogBusy.delete(key);
            if (vwMainTab === 'catalog') vwRenderBody(panel);
        }
    }

    /* ── Режим (Перс/Общий) + фильтр по типам ── */

    function vwModeRowHtml(view) {
        const useShared = !!view.shared;
        const so = (val, label) => `<option value="${val}" ${vwSort === val ? 'selected' : ''}>${label}</option>`;
        return `<div class="vw-mode-row">
            <button class="vw-mode-btn ${!useShared ? 'vw-mode-on' : ''}" data-mode="perc"><i class="fa-solid fa-user"></i> Перс</button>
            <button class="vw-mode-btn ${useShared ? 'vw-mode-on' : ''}" data-mode="shared"><i class="fa-solid fa-earth-americas"></i> Общий</button>
            <span class="vw-sort-wrap" title="Сортировка"><i class="fa-solid fa-arrow-down-wide-short"></i><select class="vw-sort-select">${so('added', 'Новые')}${so('worn', 'Недавно надетые')}${so('name', 'По имени')}</select></span>
        </div>`;
    }

    function vwFilterRowHtml(counts, total) {
        if (!total) return '';
        let h = `<div class="vw-filter-row"><button class="vw-filter-chip ${vwFilter === 'all' ? 'vw-filter-on' : ''}" data-type="all">Все <span class="vw-chip-count">${total}</span></button>`;
        for (const t of vwTypes()) {
            if (!counts[t.id]) continue;
            h += `<button class="vw-filter-chip ${vwFilter === t.id ? 'vw-filter-on' : ''}" data-type="${t.id}"><i class="fa-solid ${t.icon}"></i> ${san(t.label)} <span class="vw-chip-count">${counts[t.id]}</span></button>`;
        }
        return h + '</div>';
    }

    function vwBindModeFilter(body, panel) {
        for (const b of body.querySelectorAll('.vw-mode-btn'))
            b.addEventListener('click', () => vwSetMode(b.dataset.mode === 'shared', panel));
        body.querySelector('.vw-sort-select')?.addEventListener('change', (e) => { vwSort = e.target.value; vwPage = 0; vwRenderBody(panel); });
        for (const chip of body.querySelectorAll('.vw-filter-chip'))
            chip.addEventListener('click', () => { vwFilter = chip.dataset.type; vwPage = 0; vwRenderBody(panel); });
        // Колесо мыши → горизонтальная прокрутка ленты фильтров (скроллбар скрыт).
        const fr = body.querySelector('.vw-filter-row');
        if (fr) fr.addEventListener('wheel', (e) => { if (e.deltaY && !e.shiftKey) { fr.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
    }

    async function vwSetMode(wantShared, panel) {
        const core = swc(); if (!core) { toastr.warning('Ядро гардероба ещё грузится', 'Гардероб'); return; }
        if (core.isShared(vwSubTab) === wantShared) return;
        core.setShared(vwSubTab, wantShared);
        vwFilter = 'all'; vwPage = 0;
        core.preloadSharedActive(vwSubTab);
        const sideName = vwSubTab === 'bot' ? 'Чар' : 'Юзер';
        toastr.info(`${sideName}: ${wantShared ? 'общий гардероб (для всех персонажей)' : 'персональный гардероб'}`, 'Гардероб', { timeOut: 2200 });
        // При переходе в общий — просто надеваем уже имеющуюся копию (если есть). Импорта нет.
        if (wantShared) core.autoWearFromCurrent(vwSubTab, { force: false });
        if (window.sillyWardrobe?.updatePromptInjection) window.sillyWardrobe.updatePromptInjection();
        vwSaveAndSync();
        vwRenderBody(panel); vwRefreshBtn();
    }

    function vwToggle(id, panel) {
        const v = vwCurView();
        const o = v.find(id); const nm = o?.name || id;
        const off = v.activeId() === id;
        if (v.setActive(off ? null : id) === false) return;
        if (!off && o) { o.lastWorn = Date.now(); } // метка для сортировки «недавно надетые»
        if (v.shared && swc()?.preloadSharedActive) swc().preloadSharedActive(v.side);
        vwSaveAndSync();
        if (window.sillyWardrobe?.updatePromptInjection) window.sillyWardrobe.updatePromptInjection();
        vwRenderBody(panel); vwRefreshBtn();
        if (off) toastr.info(`«${nm}» снят`, 'Гардероб', { timeOut: 2000 });
        else toastr.success(`«${nm}» надет`, 'Гардероб', { timeOut: 2000 });
    }

    function vwEdit(id, panel) {
        const v = vwCurView();
        const o = v.find(id); if (!o) return;
        vwOpenOutfitForm({ mode: 'edit', view: v, item: o, panel });
    }

    async function vwUpload(e, panel) {
        const file = e.target.files?.[0]; if (!file) return;
        e.target.value = '';
        const v = vwCurView();
        if (!v.shared && !vwCharName()) { toastr.warning('Выберите персонажа (или включите «Общий»)', 'Гардероб'); return; }
        try {
            const maxDim = swc()?.maxDim ? swc().maxDim() : 512;
            let base64;
            if (swc()?.resizeImage) { const r = await swc().resizeImage(file, maxDim); base64 = r.base64; }
            else {
                const raw = await new Promise((res, rej) => { const r = new FileReader(); r.onloadend = () => res(r.result.split(',')[1]); r.onerror = rej; r.readAsDataURL(file); });
                base64 = raw;
                try { if (window.compressBase64Image) base64 = await window.compressBase64Image(raw, maxDim, 0.85); } catch (x) {}
            }
            vwOpenOutfitForm({ mode: 'add', view: v, base64, defaultName: file.name.replace(/\.[^.]+$/, ''), panel });
        } catch (err) { toastr.error('Ошибка загрузки: ' + err.message, 'Гардероб'); }
    }

    /* ── Единая форма добавления/редактирования образа (вместо инлайн-редактора) ── */

    function vwItemBase64(o) {
        if (o?.base64) return Promise.resolve(o.base64);
        if (o?.imagePath) return fetch(o.imagePath).then(r => r.blob()).then(b => new Promise((res, rej) => {
            const fr = new FileReader(); fr.onloadend = () => res(fr.result.split(',')[1]); fr.onerror = rej; fr.readAsDataURL(b);
        })).catch(() => null);
        return Promise.resolve(null);
    }

    // ИИ-описание: своя vision-модель (Настройки → Vision), с фолбэком на основной image-gen эндпоинт.
    async function vwAnalyzeOutfit(base64) {
        const ctx = SillyTavern.getContext();
        const sw  = ctx.extensionSettings['silly_wardrobe'] || {};
        const iig = ctx.extensionSettings[MODULE_NAME] || {};
        let ep    = (sw.visionEndpoint || '').trim().replace(/\/$/, '');
        let key   = (sw.visionApiKey   || '').trim();
        let model = (sw.visionModel    || '').trim();
        if (!ep)    ep    = (iig.endpoint || '').trim().replace(/\/$/, '');
        if (!key)   key   = (iig.apiKey   || '').trim();
        if (!model) model = (iig.model    || '').trim();
        if (!ep || !model) { toastr.warning('Настройте Vision Endpoint / Модель (Настройки → Vision API)', 'Гардероб', { timeOut: 6000 }); return null; }
        toastr.info('Анализ через Vision API…', 'Гардероб', { timeOut: 10000 });
        const resp = await fetch(`${ep}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
            body: JSON.stringify({ model, max_tokens: 200, messages: [{ role: 'user', content: [
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
                { type: 'text', text: 'Describe the outfit/clothing visible in the image in 1-2 concise sentences. Focus ONLY on garments, colors, fabrics, accessories, shoes. Do NOT describe the person, background, or pose.' }
            ]}] })
        });
        if (!resp.ok) { const t = await resp.text().catch(() => ''); throw new Error(`HTTP ${resp.status}: ${t.substring(0, 120)}`); }
        const data = await resp.json();
        const desc = data.choices?.[0]?.message?.content?.trim();
        if (desc) { toastr.success('Описание готово!', 'Гардероб', { timeOut: 2000 }); return desc; }
        throw new Error('Пустой ответ от API');
    }

    // Старое окошко (картинка + поля прямо в панели), но под новые функции:
    // тип одежды, общий гардероб (файлы), кастомные теги, ИИ-описание.
    function vwOpenOutfitForm({ mode, view, base64 = null, item = null, defaultName = '', panel }) {
        const body = document.getElementById('vw-body');
        if (!body) return;
        const isEdit = mode === 'edit';
        const types = vwTypes();
        const curType = isEdit ? vwTypeOf(item) : ((swc()?.typeIds && swc().typeIds().includes(vwFilter)) ? vwFilter : 'other');
        const previewSrc = isEdit ? vwImgSrc(item) : ('data:image/jpeg;base64,' + base64);
        const curName = isEdit ? (item.name || '') : (defaultName || '');
        const curDesc = isEdit ? (item.description || '') : '';

        body.innerHTML = `
        <div class="vw-edit">
            <div class="vw-edit-img-col">
                <img src="${san(previewSrc)}" class="vw-edit-img" alt="${san(curName)}">
            </div>
            <div class="vw-edit-fields">
                <label class="vw-label">Название</label>
                <input type="text" class="text_pole vw-edit-name" value="${san(curName)}" placeholder="Название образа">
                <label class="vw-label">Тип одежды</label>
                <select class="text_pole vw-edit-type">${types.map(t => `<option value="${t.id}" ${curType === t.id ? 'selected' : ''}>${san(t.label)}</option>`).join('')}</select>
                <label class="vw-label">Описание <small>(для промпта)</small></label>
                <textarea class="text_pole vw-edit-desc" rows="5" placeholder="Одежда, цвета, ткани, аксессуары…">${san(curDesc)}</textarea>
                <div class="vw-edit-actions">
                    <button class="vw-action-btn vw-btn-ai" id="vw-ai-btn"><i class="fa-solid fa-wand-magic-sparkles"></i> AI описание</button>
                    <button class="vw-action-btn vw-btn-save" id="vw-save-btn"><i class="fa-solid fa-check"></i> ${isEdit ? 'Сохранить' : 'Добавить'}</button>
                    <button class="vw-action-btn vw-btn-back" id="vw-back-btn"><i class="fa-solid fa-arrow-left"></i> Назад</button>
                </div>
            </div>
        </div>`;

        const nameEl = body.querySelector('.vw-edit-name');
        const typeEl = body.querySelector('.vw-edit-type');
        const descEl = body.querySelector('.vw-edit-desc');

        body.querySelector('#vw-back-btn').addEventListener('click', () => vwRenderBody(panel));

        // ИИ-описание по картинке
        body.querySelector('#vw-ai-btn').addEventListener('click', async () => {
            const btn = body.querySelector('#vw-ai-btn');
            if (btn.disabled) return;
            btn.disabled = true; const orig = btn.innerHTML;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Анализирую...';
            try {
                let b64 = base64;
                if (!b64 && item) b64 = await vwItemBase64(item);
                if (!b64) { toastr.warning('Нет картинки для анализа', 'Гардероб'); return; }
                const desc = await vwAnalyzeOutfit(b64);
                if (desc) descEl.value = desc;
            } catch (e) { toastr.error('Ошибка ИИ: ' + e.message, 'Гардероб', { timeOut: 5000 }); }
            finally { btn.disabled = false; btn.innerHTML = orig; }
        });

        // Сохранение
        body.querySelector('#vw-save-btn').addEventListener('click', async () => {
            const name = nameEl.value.trim();
            if (!name) { toastr.warning('Введите название', 'Гардероб'); return; }
            const type = typeEl.value;
            const desc = descEl.value.trim();
            const saveBtn = body.querySelector('#vw-save-btn');
            saveBtn.disabled = true; const origSave = saveBtn.innerHTML;
            saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Сохранение…';
            try {
                if (isEdit) {
                    item.name = name; item.type = type; item.description = desc;
                    if (view.shared && swc()?.preloadSharedActive) swc().preloadSharedActive(view.side);
                } else {
                    const newItem = { id: (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)), name, type, description: desc, addedAt: Date.now() };
                    if (view.shared) {
                        // ⚡ ОБЩИЙ гардероб: картинку храним ФАЙЛОМ, в settings — только путь.
                        let stored = false;
                        try {
                            if (swc()?.compress && swc()?.saveFile) {
                                const jpeg = await swc().compress(base64, swc().maxDim(), 0.82);
                                const prefix = view.side === 'bot' ? 'sw_bot_' : 'sw_user_';
                                newItem.imagePath = await swc().saveFile(jpeg, prefix + name);
                                stored = true;
                            }
                        } catch (err) { console.warn('[vw] shared file store failed, fallback base64:', err.message); }
                        if (!stored) newItem.base64 = base64;
                    } else {
                        newItem.base64 = base64;
                    }
                    view.add(newItem);
                    if (view.shared && swc()?.preloadSharedActive) swc().preloadSharedActive(view.side);
                    vwPage = Number.MAX_SAFE_INTEGER; // показать последнюю страницу с новым образом
                }
                if (window.sillyWardrobe?.updatePromptInjection) window.sillyWardrobe.updatePromptInjection();
                vwSaveAndSync();
                vwRefreshBtn();
                vwRenderBody(panel);
                toastr.success(isEdit ? 'Сохранено' : `«${name}» добавлен`, 'Гардероб', { timeOut: 2000 });
            } catch (e) {
                toastr.error('Ошибка: ' + e.message, 'Гардероб');
                saveBtn.disabled = false; saveBtn.innerHTML = origSave;
            }
        });
    }

    /* ── Обслуживание: Дубликаты + Чистка файлов (🧹) ── */

    function vwOpenMaintenance(tab) {
        const core = swc();
        if (!core?.scanOrphans) { toastr.warning('Ядро гардероба ещё грузится', 'Обслуживание'); return; }
        document.getElementById('vw-cleanup-overlay')?.remove();
        const ov = document.createElement('div'); ov.id = 'vw-cleanup-overlay';
        ov.addEventListener('click', (e) => { if (e.target === ov) closeM(); });
        const cp = document.createElement('div'); cp.id = 'vw-cleanup-panel';
        cp.innerHTML = `
            <div class="vw-cleanup-header"><span><i class="fa-solid fa-broom"></i> Обслуживание гардероба</span><button class="vw-cleanup-close" title="Закрыть"><i class="fa-solid fa-xmark"></i></button></div>
            <div class="vw-maint-tabs">
                <button class="vw-maint-tab" data-mt="dedup"><i class="fa-solid fa-clone"></i> Дубликаты</button>
                <button class="vw-maint-tab" data-mt="cleanup"><i class="fa-solid fa-broom"></i> Чистка файлов</button>
            </div>
            <div class="vw-cleanup-body" id="vw-maint-body"></div>`;
        ov.appendChild(cp); document.documentElement.appendChild(ov);
        const body = cp.querySelector('#vw-maint-body');
        function mEsc(e) { if (e.key === 'Escape') closeM(); }
        function closeM() { document.removeEventListener('keydown', mEsc); ov.remove(); }
        document.addEventListener('keydown', mEsc);
        cp.querySelector('.vw-cleanup-close').addEventListener('click', closeM);

        let cur = null;
        function show(which) {
            if (which === cur) return;
            cur = which;
            for (const t of cp.querySelectorAll('.vw-maint-tab')) t.classList.toggle('vw-maint-tab-on', t.dataset.mt === which);
            if (which === 'cleanup') vwRenderCleanup(body); else vwRenderDedup(body);
        }
        for (const t of cp.querySelectorAll('.vw-maint-tab')) t.addEventListener('click', () => show(t.dataset.mt));
        show(tab === 'cleanup' ? 'cleanup' : 'dedup');
    }

    function vwRenderCleanup(body) {
        const core = swc();
        const selected = new Set();
        let state = null;
        async function scan() {
            body.innerHTML = `<div class="vw-cleanup-loading"><i class="fa-solid fa-spinner fa-spin"></i> Сканирование…</div>`;
            try { state = await core.scanOrphans(); selected.clear(); for (const f of state.orphans) selected.add(f); render(); }
            catch (e) { body.innerHTML = `<div class="vw-cleanup-err">Ошибка: ${san(e.message)}</div>`; }
        }
        function render() {
            const { orphans, totalFiles, referencedCount, dir } = state;
            let h = `<div class="vw-cleanup-info">Используется: <b>${referencedCount}</b> · Лишних: <b>${orphans.length}</b> · Всего: ${totalFiles}</div>`;
            if (orphans.length === 0) { h += `<div class="vw-cleanup-empty"><i class="fa-solid fa-circle-check"></i> Лишних файлов нет — всё используется.</div>`; body.innerHTML = h; return; }
            h += `<div class="vw-cleanup-hint">На эти файлы не ссылается ни один наряд, НПС или референс. Клик — выбрать/снять. Удалятся только выбранные.</div>`;
            h += `<div class="vw-cleanup-tools"><span class="vw-cleanup-link" id="vw-cl-all">Выбрать все</span><span class="vw-cleanup-link" id="vw-cl-none">Снять все</span></div>`;
            h += '<div class="vw-cleanup-grid">';
            for (const f of orphans) h += `<div class="vw-cleanup-item ${selected.has(f) ? 'vw-cl-sel' : ''}" data-f="${san(f)}"><img src="${san(dir + f)}" loading="lazy" onerror="this.style.opacity=0.15"><div class="vw-cl-check"><i class="fa-solid fa-check"></i></div></div>`;
            h += '</div>';
            h += `<div class="vw-cleanup-actions"><button class="vw-cleanup-del">Удалить выбранные (<span id="vw-cl-count">${selected.size}</span>)</button></div>`;
            body.innerHTML = h;
            body.querySelector('#vw-cl-all').addEventListener('click', () => { for (const f of orphans) selected.add(f); render(); });
            body.querySelector('#vw-cl-none').addEventListener('click', () => { selected.clear(); render(); });
            for (const it of body.querySelectorAll('.vw-cleanup-item'))
                it.addEventListener('click', () => { const f = it.dataset.f; if (selected.has(f)) selected.delete(f); else selected.add(f); it.classList.toggle('vw-cl-sel'); const c = body.querySelector('#vw-cl-count'); if (c) c.textContent = selected.size; });
            body.querySelector('.vw-cleanup-del').addEventListener('click', async () => {
                if (selected.size === 0) { toastr.info('Ничего не выбрано', 'Чистка'); return; }
                if (!confirm(`Удалить ${selected.size} файлов с сервера? Это необратимо.`)) return;
                const del = body.querySelector('.vw-cleanup-del'); del.style.pointerEvents = 'none'; del.textContent = 'Удаление…';
                const res = await core.deleteFiles(state.dir, [...selected]);
                toastr.success(`Удалено: ${res.ok}${res.fail ? `, ошибок: ${res.fail}` : ''}`, 'Чистка', { timeOut: 4000 });
                scan();
            });
        }
        scan();
    }

    // Дубликаты в текущем гардеробе (последствие импорта): группируем по имени+типу / srcId / файлу.
    // Удаляем только записи гардероба; файлы-картинки потом уберёт «Чистка».
    function vwRenderDedup(body) {
        const view = vwCurView();
        const sideName = vwSubTab === 'bot' ? 'Чар' : 'Юзер';
        const modeName = view.shared ? 'общий' : 'персональный';
        const dupKey = (o) => {
            const nm = (o.name || '').trim().toLowerCase();
            if (nm && nm !== 'без имени') return 'n:' + nm + '|' + vwTypeOf(o);
            if (o.srcId) return 's:' + o.srcId;
            if (o.imagePath) return 'p:' + o.imagePath;
            return 'u:' + o.id; // уникум — не дубль
        };
        const selected = new Set();
        let dupItems = [];
        function compute() {
            const list = view.list() || [];
            const groups = new Map();
            for (const o of list) {
                const k = dupKey(o);
                if (k[0] === 'u') continue;
                let arr = groups.get(k); if (!arr) groups.set(k, arr = []); arr.push(o);
            }
            const activeId = view.activeId();
            dupItems = []; selected.clear();
            let groupCount = 0;
            for (const g of groups.values()) {
                if (g.length < 2) continue;
                groupCount++;
                const keep = g.find(o => o.id === activeId) || g.reduce((a, b) => ((a.addedAt || 0) <= (b.addedAt || 0) ? a : b));
                for (const o of g) if (o.id !== keep.id) { dupItems.push(o); selected.add(o.id); }
            }
            return groupCount;
        }
        function paint() {
            for (const it of body.querySelectorAll('.vw-cleanup-item')) it.classList.toggle('vw-cl-sel', selected.has(it.dataset.id));
            const c = body.querySelector('#vw-dd-count'); if (c) c.textContent = selected.size;
        }
        function render() {
            const groupCount = compute();
            const total = (view.list() || []).length;
            let h = `<div class="vw-cleanup-info">Гардероб: <b>${san(sideName)}</b> (${san(modeName)}) · дубликатов: <b>${dupItems.length}</b> в ${groupCount} группах · всего: ${total}</div>`;
            if (dupItems.length === 0) { h += `<div class="vw-cleanup-empty"><i class="fa-solid fa-circle-check"></i> Дубликатов не найдено.</div>`; body.innerHTML = h; return; }
            h += `<div class="vw-cleanup-hint">По одному образу из каждой группы остаётся (активный или самый ранний), остальные помечены на удаление. Клик — снять/выбрать. Для общего гардероба удаляются и записи, и неиспользуемые файлы.</div>`;
            h += `<div class="vw-cleanup-tools"><span class="vw-cleanup-link" id="vw-dd-all">Выбрать все</span><span class="vw-cleanup-link" id="vw-dd-none">Снять все</span></div>`;
            h += '<div class="vw-cleanup-grid">';
            for (const o of dupItems) h += `<div class="vw-cleanup-item ${selected.has(o.id) ? 'vw-cl-sel' : ''}" data-id="${san(o.id)}" title="${san(o.name || '')}"><img src="${san(vwImgSrc(o))}" loading="lazy" onerror="this.style.opacity=0.15"><div class="vw-cl-check"><i class="fa-solid fa-check"></i></div></div>`;
            h += '</div>';
            h += `<div class="vw-cleanup-actions"><button class="vw-cleanup-del vw-dd-del">Удалить дубли (<span id="vw-dd-count">${selected.size}</span>)</button></div>`;
            body.innerHTML = h;
            body.querySelector('#vw-dd-all').addEventListener('click', () => { for (const o of dupItems) selected.add(o.id); paint(); });
            body.querySelector('#vw-dd-none').addEventListener('click', () => { selected.clear(); paint(); });
            for (const it of body.querySelectorAll('.vw-cleanup-item'))
                it.addEventListener('click', () => { const id = it.dataset.id; if (selected.has(id)) selected.delete(id); else selected.add(id); paint(); });
            body.querySelector('.vw-dd-del').addEventListener('click', () => {
                if (selected.size === 0) { toastr.info('Ничего не выбрано', 'Дубликаты'); return; }
                if (!confirm(`Удалить ${selected.size} дубликатов из гардероба «${sideName} (${modeName})»?\n\nОстанется по одному каждого. В общем гардеробе лишние файлы тоже удалятся с сервера.`)) return;
                const ids = [...selected];
                for (const id of ids) view.remove(id);
                if (view.shared && swc()?.preloadSharedActive) swc().preloadSharedActive(view.side);
                if (window.sillyWardrobe?.updatePromptInjection) window.sillyWardrobe.updatePromptInjection();
                vwSaveAndSync();
                toastr.success(`Удалено дубликатов: ${ids.length}`, 'Дубликаты', { timeOut: 4000 });
                const wbPanel = document.getElementById('vw-panel');
                if (wbPanel) { vwPage = 0; vwRenderBody(wbPanel); vwRefreshBtn(); }
                render();
            });
        }
        render();
    }

    /* ── NPC ── */

    function vwNpcImgSrc(n) {
        if (n.imageBase64) return 'data:image/jpeg;base64,' + n.imageBase64;
        if (n.imageData)   return 'data:image/jpeg;base64,' + n.imageData;
        if (n.imagePath)   return n.imagePath;
        return '';
    }

    function vwRenderNpc(body, panel) {
        const d = vwIIGData();
        const npcs = d.npcReferences || [];

        if (npcs.length === 0) {
            body.innerHTML = `<div class="vw-empty"><i class="fa-solid fa-user-group"></i><p>НПС не добавлены<br><small>Введите имя и нажмите «Добавить»</small></p></div>`;
            return;
        }

        if (vwNpcView === 'grid') {
            let html = '<div class="vw-npc-grid">';
            for (let i = 0; i < npcs.length; i++) {
                const n = npcs[i]; const on = n.enabled !== false;
                const imgSrc = vwNpcImgSrc(n);
                html += `<div class="vw-npc-card ${on ? '' : 'vw-npc-off'}" data-idx="${i}">
                    <div class="vw-npc-img-wrap">
                        ${imgSrc ? `<img src="${imgSrc}" class="vw-npc-img" alt="${san(n.name)}" loading="lazy">` : `<div class="vw-npc-placeholder"><i class="fa-solid fa-user"></i></div>`}
                        <button class="vw-npc-toggle-btn ${on ? 'vw-on' : ''}" data-idx="${i}" title="${on ? 'Выключить' : 'Включить'}">
                            <i class="fa-solid ${on ? 'fa-toggle-on' : 'fa-toggle-off'}"></i>
                        </button>
                    </div>
                    ${n.outfit ? `<div class="vw-npc-outfit" title="${san(n.outfit.description || '')}">
                        ${n.outfit.imagePath ? `<img src="${san(n.outfit.imagePath)}" alt="">` : '<i class="fa-solid fa-shirt"></i>'}
                        <span>${san(n.outfit.name || 'Наряд')}</span>
                        <button class="vw-ic-btn vw-npc-unwear" data-idx="${i}" title="Снять наряд"><i class="fa-solid fa-xmark"></i></button>
                    </div>` : ''}
                    <div class="vw-npc-foot">
                        <span class="vw-npc-name">${san(n.name)}</span>
                        <div class="vw-npc-btns">
                            <label class="vw-ic-btn vw-npc-up" title="Загрузить фото">
                                <i class="fa-solid fa-image"></i>
                                <input type="file" accept="image/*" style="display:none" class="vw-npc-file" data-idx="${i}">
                            </label>
                            <button class="vw-ic-btn vw-npc-del" data-idx="${i}" title="Удалить"><i class="fa-solid fa-trash-can"></i></button>
                        </div>
                    </div>
                </div>`;
            }
            html += '</div>';
            body.innerHTML = html;
        } else {
            let html = '<div class="vw-list">';
            for (let i = 0; i < npcs.length; i++) {
                const n = npcs[i]; const on = n.enabled !== false;
                const imgSrc = vwNpcImgSrc(n);
                html += `<div class="vw-row ${on ? '' : 'vw-npc-row-off'}" data-idx="${i}">
                    <div class="vw-row-thumb-wrap">
                        ${imgSrc ? `<img src="${imgSrc}" class="vw-row-thumb" alt="${san(n.name)}" loading="lazy">` : `<div class="vw-row-thumb vw-npc-no-img"><i class="fa-solid fa-user"></i></div>`}
                    </div>
                    <div class="vw-row-info"><span class="vw-row-name">${san(n.name)}</span>${n.outfit ? `<span class="vw-row-desc"><i class="fa-solid fa-shirt"></i> ${san(n.outfit.name || 'Наряд')}</span>` : ''}</div>
                    <div class="vw-row-btns">
                        <button class="vw-ic-btn vw-npc-list-toggle ${on ? 'vw-green' : ''}" data-idx="${i}" title="${on ? 'Выключить' : 'Включить'}"><i class="fa-solid ${on ? 'fa-toggle-on' : 'fa-toggle-off'}"></i></button>
                        ${n.outfit ? `<button class="vw-ic-btn vw-npc-unwear" data-idx="${i}" title="Снять наряд"><i class="fa-solid fa-shirt"></i></button>` : ''}
                        <label class="vw-ic-btn vw-npc-up" title="Загрузить фото"><i class="fa-solid fa-image"></i><input type="file" accept="image/*" style="display:none" class="vw-npc-file" data-idx="${i}"></label>
                        <button class="vw-ic-btn vw-npc-del" data-idx="${i}" title="Удалить"><i class="fa-solid fa-trash-can"></i></button>
                    </div>
                </div>`;
            }
            html += '</div>';
            body.innerHTML = html;
        }

        /* events */
        for (const btn of body.querySelectorAll('.vw-npc-toggle-btn, .vw-npc-list-toggle'))
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = +btn.dataset.idx; const d2 = vwIIGData();
                if (!d2.npcReferences?.[idx]) return;
                d2.npcReferences[idx].enabled = !(d2.npcReferences[idx].enabled !== false);
                vwSaveAndSync(); vwRenderNpc(body, panel); vwRefreshBtn();
            });

        for (const btn of body.querySelectorAll('.vw-npc-unwear'))
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const d2 = vwIIGData(); const npc = d2.npcReferences?.[+btn.dataset.idx];
                if (!npc?.outfit) return;
                const name = npc.outfit.name || 'наряд';
                delete npc.outfit; // файл остаётся до «Чистки файлов»
                vwSaveAndSync();
                if (window.sillyWardrobe?.updatePromptInjection) window.sillyWardrobe.updatePromptInjection();
                toastr.info(`С «${npc.name}» снято: ${name}`, 'НПС', { timeOut: 2000 });
                vwRenderNpc(body, panel);
            });

        for (const fi of body.querySelectorAll('.vw-npc-file'))
            fi.addEventListener('change', async (e) => {
                const idx = +fi.dataset.idx; const file = e.target.files?.[0]; if (!file) return; e.target.value = '';
                try {
                    const raw = await new Promise((res, rej) => { const r = new FileReader(); r.onloadend = () => res(r.result.split(',')[1]); r.onerror = rej; r.readAsDataURL(file); });
                    let b64 = raw;
                    try { if (window.compressBase64Image) b64 = await window.compressBase64Image(raw, 768, 0.8); } catch(x) {}
                    const d2 = vwIIGData(); if (!d2.npcReferences?.[idx]) return;
                    d2.npcReferences[idx].imageBase64 = b64; d2.npcReferences[idx].imagePath = '';
                    vwSaveAndSync(); toastr.success(`Фото для «${d2.npcReferences[idx].name}» загружено`, 'НПС', { timeOut: 2000 });
                    vwRenderNpc(body, panel);
                } catch(err) { toastr.error('Ошибка загрузки', 'НПС'); }
            });

        for (const btn of body.querySelectorAll('.vw-npc-del'))
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = +btn.dataset.idx; const d2 = vwIIGData();
                const name = d2.npcReferences?.[idx]?.name || `НПС ${idx + 1}`;
                if (confirm(`Удалить НПС «${name}»?`)) {
                    d2.npcReferences.splice(idx, 1); vwSaveAndSync();
                    toastr.info(`«${name}» удалён`, 'НПС', { timeOut: 2000 });
                    vwRenderNpc(body, panel); vwRefreshBtn();
                }
            });
    }

    function vwAddNpc(panel) {
        const inp = document.getElementById('vw-npc-inp');
        const name = inp?.value?.trim();
        if (!name) { toastr.warning('Введите имя НПС', 'НПС'); return; }
        const d = vwIIGData();
        if (!Array.isArray(d.npcReferences)) d.npcReferences = [];
        if (d.npcReferences.some(n => n.name.toLowerCase() === name.toLowerCase())) {
            toastr.warning(`НПС «${name}» уже существует`, 'НПС'); return;
        }
        d.npcReferences.push({ name, imageBase64: '', imagePath: '', enabled: true });
        vwSaveAndSync(); if (inp) inp.value = '';
        toastr.success(`НПС «${name}» добавлен!`, 'НПС', { timeOut: 2000 });
        vwRenderBody(panel); vwRefreshBtn();
    }

    /* ── Init ── */

    const _ctx = SillyTavern.getContext();
    _ctx.eventSource.on(_ctx.event_types.APP_READY, () => { vwInjectBtn(); });
    _ctx.eventSource.on(_ctx.event_types.CHAT_CHANGED, () => { setTimeout(vwInjectBtn, 400); });
    setTimeout(vwInjectBtn, 800);
    setTimeout(vwInjectBtn, 2500);

})();


/* ╔═══════════════════════════════════════════════════════════════╗
   ║  MODULE 4 — Quick Settings Panel (double-tap / double-click) ║
   ╚═══════════════════════════════════════════════════════════════╝ */
(function initQuickSettings() {
    'use strict';

    let qsOpen = false;

    /* ── tiny helpers ── */
    const san = t => { const d = document.createElement('div'); d.textContent = t||''; return d.innerHTML; };
    const mk  = (tag, props={}) => Object.assign(document.createElement(tag), props);
    const ctx = () => SillyTavern.getContext();
    const iig = () => ctx().extensionSettings[MODULE_NAME] || null;
    const sw  = () => ctx().extensionSettings['silly_wardrobe']   || null;
    const saveAll = () => {
        ctx().saveSettingsDebounced();
        try { const s=iig(); if(s) localStorage.setItem('iig_npc_refs_v3', JSON.stringify(s.npcReferences||[])); } catch(e){}
    };

    /* ── panel lifecycle ── */
    function qsClose() {
        qsOpen = false;
        document.getElementById('qs-overlay')?.remove();
        document.removeEventListener('keydown', onEsc);
    }
    const onEsc = e => { if (e.key==='Escape') qsClose(); };

    function qsOpen_() {
        if (qsOpen) { qsClose(); return; }
        // close wardrobe if open
        document.getElementById('vw-overlay')?.remove();
        qsOpen = true;

        const ov = mk('div', { id: 'qs-overlay' });
        ov.addEventListener('click', e => { if (e.target===ov) qsClose(); });

        const panel = mk('div', { id: 'qs-panel' });

        /* swipe-down */
        let sy=0, dy=0, sw2=false;
        panel.addEventListener('touchstart', e => {
            if (!panel.querySelector('.qs-header')?.contains(e.target)) return;
            sy=e.touches[0].clientY; dy=0; sw2=true;
        }, {passive:true});
        panel.addEventListener('touchmove', e => {
            if (!sw2) return; dy=e.touches[0].clientY-sy;
            if (dy>0) { panel.style.transform=`translateY(${Math.sqrt(dy)*5}px)`; panel.style.transition='none'; }
        }, {passive:true});
        panel.addEventListener('touchend', () => {
            if (!sw2) return; sw2=false;
            panel.style.transform=''; panel.style.transition='';
            if (dy>80) { panel.style.transition='transform .25s'; panel.style.transform='translateY(110%)'; ov.style.transition='opacity .25s'; ov.style.opacity='0'; setTimeout(qsClose, 240); }
        }, {passive:true});

        /* header */
        const header = mk('div', { className: 'qs-header' });
        const title  = mk('div', { className: 'qs-title', innerHTML: 'Быстрые настройки' });
        const closeB = mk('button', { className: 'qs-close-btn', innerHTML: '<i class="fa-solid fa-xmark"></i>' });
        closeB.addEventListener('click', qsClose);
        header.append(title, closeB);

        /* body */
        const body = mk('div', { className: 'qs-body' });
        body.append(buildApiSection(), buildStylesSection(), buildRefsSection(), buildVisionSection());

        panel.append(header, body);
        ov.appendChild(panel);
        document.documentElement.appendChild(ov);
        document.addEventListener('keydown', onEsc);
    }

    /* ══ accordion factory ══ */
    function accordion(iconCls, labelTxt, buildFn, openDefault=false) {
        const wrap = mk('div', { className: 'qs-acc' + (openDefault?' open':'') });
        const head = mk('div', { className: 'qs-acc-head' });
        const lbl  = mk('div', { className: 'qs-acc-label', innerHTML: `<i class="${iconCls}"></i> ${labelTxt}` });
        const chev = mk('i',   { className: 'fa-solid fa-chevron-down qs-acc-chevron' });
        head.append(lbl, chev);

        const body = mk('div', { className: 'qs-acc-body' });
        buildFn(body);  // body NOT in DOM yet — all refs must be stored in variables!

        head.addEventListener('click', () => { wrap.classList.toggle('open'); });
        wrap.append(head, body);
        return wrap;
    }

    /* ── row builders ── */
    function rowEl(labelTxt, ...children) {
        const row = mk('div', { className: 'qs-row' });
        const lbl = mk('span', { className: 'qs-lbl', textContent: labelTxt });
        row.append(lbl, ...children);
        return row;
    }
    function iconBtn(icon, title='') {
        const b = mk('button', { className: 'qs-ibtn', title, innerHTML: `<i class="${icon}"></i>` });
        return b;
    }
    function actionBtn(icon, text) {
        const b = mk('button', { className: 'qs-action-btn', innerHTML: `<i class="${icon}"></i> ${text}` });
        return b;
    }
    function sep() { return mk('div', { className: 'qs-sep' }); }

    /* ══════════════════════════════════════════
       SECTION 1 — API Settings
    ══════════════════════════════════════════ */
    function buildApiSection() {
        return accordion('fa-solid fa-plug', 'Настройки API', body => {
            const s = iig();
            if (!s) { body.appendChild(mk('p', { className:'qs-hint', textContent:'Расширение не готово' })); return; }

            /* — Профиль подключения — */
            const profiles = window._iigConnectionProfiles;
            if (profiles) {
                const selProfile = mk('select', { className:'text_pole' });
                profiles.list().forEach(p => { const o=mk('option',{value:p.id,textContent:p.name}); if(p.id===profiles.activeId())o.selected=true; selProfile.appendChild(o); });
                selProfile.addEventListener('change', () => {
                    const p = profiles.load(selProfile.value);
                    if (!p) return;
                    toastr.info(`Профиль «${p.name}»`, '', {timeOut:1500});
                    // Перестраиваем панель, чтобы поля показали значения нового профиля.
                    qsClose(); qsOpen_();
                });
                body.appendChild(rowEl('Профиль', selProfile));
            }

            /* — API Type — */
            const selType = mk('select', { className:'text_pole' });
            [['openai','OpenAI-совместимый'],['void','VoidAI'],['gemini','Gemini / Nano-Banana'],['naistera','Naistera / Grok']]
                .forEach(([v,t]) => { const o=mk('option',{value:v,textContent:t}); if(s.apiType===v)o.selected=true; selType.appendChild(o); });
            body.appendChild(rowEl('Тип API', selType));

            /* — Endpoint — */
            const inpEp = mk('input', { type:'text', className:'text_pole', value:s.endpoint||'', placeholder:'https://api.example.com' });
            body.appendChild(rowEl('Эндпоинт', inpEp));

            /* — Presets — */
            const pills = mk('div', { className:'qs-pills' });
            [['VoidAI','https://api.voidai.app','void'],['RouteMyAI','https://api.routemyai.com','openai'],['OpenAI','https://api.openai.com','openai']]
                .forEach(([name,url,type]) => {
                    const p = mk('div', { className:'qs-pill', textContent:name });
                    p.addEventListener('click', () => {
                        const ss=iig(); if(!ss) return;
                        ss.endpoint=url; ss.apiType=type;
                        inpEp.value=url; selType.value=type;
                        toggleNaisteraVis(type);
                        // sync main UI
                        const mEp=document.getElementById('iig_endpoint'); if(mEp) mEp.value=url;
                        const mT=document.getElementById('iig_api_type'); if(mT){mT.value=type; mT.dispatchEvent(new Event('change'));}
                        saveAll();
                        toastr.info(url, '', {timeOut:2000});
                    });
                    pills.appendChild(p);
                });
            body.appendChild(pills);

            /* — API Key — */
            const inpKey = mk('input', { type:'password', className:'text_pole', value:s.apiKey||'' });
            const btnEye = iconBtn('fa-solid fa-eye', 'Показать/скрыть');
            btnEye.addEventListener('click', () => {
                inpKey.type = inpKey.type==='password' ? 'text' : 'password';
                btnEye.querySelector('i').className = inpKey.type==='password' ? 'fa-solid fa-eye' : 'fa-solid fa-eye-slash';
            });
            body.appendChild(rowEl('API ключ', inpKey, btnEye));

            /* — Model — */
            const selModel = mk('select', { className:'text_pole' });
            if (s.model) { const o=mk('option',{value:s.model,textContent:s.model,selected:true}); selModel.appendChild(o); }
            else { selModel.appendChild(mk('option',{value:'',textContent:'-- Выбрать --'})); }

            const btnRefresh = iconBtn('fa-solid fa-sync', 'Обновить модели');
            btnRefresh.addEventListener('click', async () => {
                const ico = btnRefresh.querySelector('i');
                ico.className = 'fa-solid fa-spinner fa-spin';
                try {
                    const ss=iig(); if(!ss) throw new Error('no settings');
                    const url=`${(ss.endpoint||'').replace(/\/$/,'')}/v1/models`;
                    const resp=await fetch(url,{headers:{'Authorization':`Bearer ${ss.apiKey}`}});
                    if(!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    const data=await resp.json();
                    const vidKW=['sora','kling','video','veo','pika','runway','luma','gen-3','cogvideo','mochi','seedance','vidu','wan-ai','hunyuan','hailuo'];
                    const imgKW=['dall-e','flux','imagen','image','nano-banana','gpt-image','dreamshaper','ideogram','wanx','qwen','seedream','hidream'];
                    const models=(data.data||[]).filter(m=>{
                        const mid=m.id.toLowerCase();
                        if(vidKW.some(k=>mid.includes(k))) return false;
                        if(imgKW.some(k=>mid.includes(k))) return true;
                        return false;
                    }).map(m=>m.id);
                    selModel.innerHTML='<option value="">-- Выбрать --</option>';
                    models.forEach(m=>{ const o=mk('option',{value:m,textContent:m}); if(m===ss.model)o.selected=true; selModel.appendChild(o); });
                    toastr.success(`Моделей: ${models.length}`, '', {timeOut:2000});
                } catch(err) { toastr.error('Ошибка: '+err.message, ''); }
                ico.className = 'fa-solid fa-sync';
            });

            const modelRow = rowEl('Модель', selModel, btnRefresh);
            body.appendChild(modelRow);

            const naisteraHint = mk('p', { className:'qs-hint', textContent:'Токен из Telegram бота. Модель не требуется.' });
            naisteraHint.style.display = s.apiType==='naistera' ? '' : 'none';
            body.appendChild(naisteraHint);

            function toggleNaisteraVis(type) {
                const isN = type==='naistera';
                modelRow.style.display     = isN ? 'none' : '';
                naisteraHint.style.display = isN ? '' : 'none';
            }
            toggleNaisteraVis(s.apiType||'openai');

            /* — Test — */
            const btnTest = actionBtn('fa-solid fa-wifi', 'Тест соединения');
            btnTest.addEventListener('click', async () => {
                const ss=iig(); if(!ss) return;
                btnTest.innerHTML='<i class="fa-solid fa-spinner fa-spin"></i> Проверяю...';
                btnTest.className='qs-action-btn';
                try {
                    if (!ss.endpoint||!ss.apiKey) throw new Error('Заполните эндпоинт и ключ');
                    const url=`${ss.endpoint.replace(/\/$/,'')}/v1/models`;
                    const resp=await fetch(url,{headers:{'Authorization':`Bearer ${ss.apiKey}`}});
                    if(!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    const cnt=((await resp.json()).data||[]).length;
                    btnTest.innerHTML=`<i class="fa-solid fa-check"></i> OK — ${cnt} моделей`;
                    btnTest.className='qs-action-btn ok';
                } catch(err) {
                    btnTest.innerHTML=`<i class="fa-solid fa-xmark"></i> ${err.message.slice(0,50)}`;
                    btnTest.className='qs-action-btn err';
                }
                setTimeout(()=>{btnTest.innerHTML='<i class="fa-solid fa-wifi"></i> Тест соединения'; btnTest.className='qs-action-btn';},3500);
            });
            body.appendChild(btnTest);

            /* — Events — */
            selType.addEventListener('change', () => {
                const ss=iig(); if(!ss) return;
                ss.apiType=selType.value; toggleNaisteraVis(selType.value); saveAll();
                const mT=document.getElementById('iig_api_type'); if(mT){mT.value=selType.value; mT.dispatchEvent(new Event('change'));}
            });
            inpEp.addEventListener('input', () => {
                const ss=iig(); if(!ss) return;
                ss.endpoint=inpEp.value; saveAll();
                const m=document.getElementById('iig_endpoint'); if(m) m.value=inpEp.value;
            });
            inpKey.addEventListener('input', () => {
                const ss=iig(); if(!ss) return;
                ss.apiKey=inpKey.value; saveAll();
                const m=document.getElementById('iig_api_key'); if(m) m.value=inpKey.value;
            });
            selModel.addEventListener('change', () => {
                const ss=iig(); if(!ss) return;
                ss.model=selModel.value; saveAll();
                const m=document.getElementById('iig_model'); if(m){m.value=selModel.value; m.dispatchEvent(new Event('change'));}
            });

        }, true); // open by default
    }

    /* ══════════════════════════════════════════
       SECTION 2 — Character References
    ══════════════════════════════════════════ */
    function buildRefsSection() {
        return accordion('fa-solid fa-user-group', 'Референсы персонажей', body => {
            const s = iig();
            if (!s) { body.appendChild(mk('p', {className:'qs-hint', textContent:'Расширение не готово'})); return; }

            /* ── {{char}} avatar ── */
            const chkChar = mk('input', { type:'checkbox', checked:!!s.sendCharAvatar });
            const lblChar = mk('label', { className:'qs-chk-row', innerHTML:' Отправлять аватар {{char}}' });
            lblChar.prepend(chkChar);
            body.appendChild(lblChar);

            /* char manual photo */
            const charSub = mk('div', { className:'qs-sub' });

            const charToggle = mk('button', { className:'qs-pill', style:'margin-bottom:4px;', innerHTML:'<i class="fa-solid fa-robot" style="font-size:10px;margin-right:4px;"></i>Фото {{char}} вручную' });
            const charPhotoWrap = mk('div');
            charPhotoWrap.style.display = 'none';

            const charThumb = mk('img', { className:'qs-photo-thumb' });
            charThumb.src = s.charRef?.imagePath || (s.charRef?.imageBase64 ? 'data:image/jpeg;base64,'+s.charRef.imageBase64 : '');
            charThumb.onerror = () => { charThumb.src=''; };

            const charMeta = mk('span', { className:'qs-photo-meta', textContent: s.charRef?.imagePath ? '✓ фото загружено' : 'Если загружено — заменяет аватар выше' });

            const charUpFile = mk('input', { type:'file', accept:'image/*' });
            charUpFile.style.display = 'none';
            const charUpBtn = document.createElement('label');
            charUpBtn.className = 'qs-ibtn';
            charUpBtn.title = 'Загрузить фото';
            charUpBtn.innerHTML = '<i class="fa-solid fa-upload"></i>';
            charUpBtn.appendChild(charUpFile);

            const charDelBtn = iconBtn('fa-solid fa-trash', 'Очистить');
            charDelBtn.style.color='#e87070';

            const charBtns = mk('div', {className:'qs-photo-btns'});
            charBtns.append(charUpBtn, charDelBtn);

            const charRow = mk('div', {className:'qs-photo-row'});
            charRow.append(charThumb, charMeta, charBtns);
            charPhotoWrap.appendChild(charRow);

            charToggle.addEventListener('click', () => {
                const open = charPhotoWrap.style.display==='none';
                charPhotoWrap.style.display = open ? '' : 'none';
            });
            charSub.append(charToggle, charPhotoWrap);
            body.append(lblChar, charSub, sep());

            /* ── {{user}} avatar ── */
            const chkUser = mk('input', { type:'checkbox', checked:!!s.sendUserAvatar });
            const lblUser = mk('label', { className:'qs-chk-row', innerHTML:' Отправлять аватар {{user}}' });
            lblUser.prepend(chkUser);
            body.appendChild(lblUser);

            /* user avatar selector — visual thumbnail grid */
            const userSub = mk('div', { className:'qs-sub' });
            userSub.style.display = s.sendUserAvatar ? '' : 'none';

            // Header row: label + refresh button
            const uaHeaderRow = mk('div', { className:'qs-avatar-header' });
            const uaLabel = mk('span', { className:'qs-lbl', textContent:'Аватар {{user}}' });
            const btnRefreshUA = iconBtn('fa-solid fa-sync', 'Загрузить аватары');
            uaHeaderRow.append(uaLabel, btnRefreshUA);
            userSub.appendChild(uaHeaderRow);

            // Current selection preview
            const uaCurrentWrap = mk('div', { className:'qs-avatar-current-wrap' });
            let _curAvatarFile = s.userAvatarFile || '';
            function updateCurrentDisplay() {
                uaCurrentWrap.innerHTML = '';
                if (_curAvatarFile) {
                    const img = mk('img', { className:'qs-avatar-cur-thumb' });
                    img.src = `/User Avatars/${encodeURIComponent(_curAvatarFile)}`;
                    img.onerror = () => { img.src = ''; img.className += ' broken'; };
                    const name = mk('span', { className:'qs-avatar-cur-name', textContent: _curAvatarFile });
                    const clearBtn = mk('button', { className:'qs-ibtn', title:'Авто (из персоны)', innerHTML:'<i class="fa-solid fa-xmark"></i>' });
                    clearBtn.addEventListener('click', () => { _curAvatarFile = ''; updateCurrentDisplay(); renderAvatarGrid([]); const ss=iig(); if(ss){ss.userAvatarFile=''; saveAll();} });
                    uaCurrentWrap.append(img, name, clearBtn);
                } else {
                    uaCurrentWrap.innerHTML = `<span style="font-size:0.78em;opacity:0.45;">-- Авто (из персоны) --</span>`;
                }
            }
            updateCurrentDisplay();
            userSub.appendChild(uaCurrentWrap);

            // Visual thumbnail grid (populated on load)
            const uaGrid = mk('div', { className:'qs-avatar-grid' });
            userSub.appendChild(uaGrid);

            let _avatarList = [];
            function renderAvatarGrid(avatars) {
                _avatarList = avatars;
                uaGrid.innerHTML = '';
                if (avatars.length === 0) {
                    uaGrid.innerHTML = `<span class="qs-hint">Нажмите <i class="fa-solid fa-sync"></i> для загрузки</span>`;
                    return;
                }
                // "Auto" item
                const autoItem = mk('div', { className:`qs-avatar-item ${!_curAvatarFile ? 'qs-avatar-sel' : ''}` });
                autoItem.innerHTML = `<div class="qs-avatar-auto-icon"><i class="fa-solid fa-wand-magic-sparkles"></i></div><span>Авто</span>`;
                autoItem.addEventListener('click', () => {
                    _curAvatarFile = ''; updateCurrentDisplay();
                    uaGrid.querySelectorAll('.qs-avatar-item').forEach(el => el.classList.remove('qs-avatar-sel'));
                    autoItem.classList.add('qs-avatar-sel');
                    const ss=iig(); if(ss){ss.userAvatarFile=''; saveAll();}
                });
                uaGrid.appendChild(autoItem);

                for (const f of avatars) {
                    const item = mk('div', { className:`qs-avatar-item ${_curAvatarFile===f ? 'qs-avatar-sel' : ''}` });
                    const img = mk('img', { className:'qs-avatar-item-img' });
                    img.src = `/User Avatars/${encodeURIComponent(f)}`;
                    img.alt = f;
                    img.loading = 'lazy';
                    img.onerror = () => { img.replaceWith(mk('div', { className:'qs-avatar-item-broken', innerHTML:'<i class="fa-solid fa-user"></i>' })); };
                    const lbl = mk('span', { textContent: f.replace(/\.[^.]+$/, '') });
                    item.append(img, lbl);
                    item.addEventListener('click', () => {
                        _curAvatarFile = f; updateCurrentDisplay();
                        uaGrid.querySelectorAll('.qs-avatar-item').forEach(el => el.classList.remove('qs-avatar-sel'));
                        item.classList.add('qs-avatar-sel');
                        const ss=iig(); if(ss){ss.userAvatarFile=f; saveAll();}
                    });
                    uaGrid.appendChild(item);
                }
            }
            renderAvatarGrid([]); // show empty state initially

            userSub.appendChild(uaGrid);

            /* user manual photo */
            const userToggle = mk('button', { className:'qs-pill', style:'margin-bottom:4px;margin-top:4px;', innerHTML:'<i class="fa-solid fa-user" style="font-size:10px;margin-right:4px;"></i>Фото {{user}} вручную' });
            const userPhotoWrap = mk('div');
            userPhotoWrap.style.display = 'none';

            const userThumb = mk('img', { className:'qs-photo-thumb' });
            userThumb.src = s.userRef?.imagePath || (s.userRef?.imageBase64 ? 'data:image/jpeg;base64,'+s.userRef.imageBase64 : '');
            userThumb.onerror = () => { userThumb.src=''; };

            const userMeta = mk('span', { className:'qs-photo-meta', textContent: s.userRef?.imagePath ? '✓ фото загружено' : 'Если загружено — заменяет аватар выше' });

            const userUpFile = mk('input', { type:'file', accept:'image/*' });
            userUpFile.style.display = 'none';
            const userUpBtn = document.createElement('label');
            userUpBtn.className = 'qs-ibtn';
            userUpBtn.title = 'Загрузить фото';
            userUpBtn.innerHTML = '<i class="fa-solid fa-upload"></i>';
            userUpBtn.appendChild(userUpFile);

            const userDelBtn = iconBtn('fa-solid fa-trash', 'Очистить');
            userDelBtn.style.color='#e87070';

            const userBtns = mk('div', {className:'qs-photo-btns'});
            userBtns.append(userUpBtn, userDelBtn);

            const userRow2 = mk('div', {className:'qs-photo-row'});
            userRow2.append(userThumb, userMeta, userBtns);
            userPhotoWrap.appendChild(userRow2);

            userToggle.addEventListener('click', () => {
                const open = userPhotoWrap.style.display==='none';
                userPhotoWrap.style.display = open ? '' : 'none';
            });
            userSub.append(userToggle, userPhotoWrap);
            body.append(userSub);

            /* ── Events ── */

            chkChar.addEventListener('change', () => {
                const ss=iig(); if(!ss) return;
                ss.sendCharAvatar=chkChar.checked; saveAll();
                const m=document.getElementById('iig_send_char_avatar'); if(m) m.checked=chkChar.checked;
            });

            chkUser.addEventListener('change', () => {
                const ss=iig(); if(!ss) return;
                ss.sendUserAvatar=chkUser.checked; saveAll();
                userSub.style.display = chkUser.checked ? '' : 'none';
                const m=document.getElementById('iig_send_user_avatar'); if(m) m.checked=chkUser.checked;
            });

            // Load user avatars on demand
            let avatarsLoaded = false;
            async function loadAvatars() {
                if (avatarsLoaded) return;
                const ico = btnRefreshUA.querySelector('i');
                ico.className='fa-solid fa-spinner fa-spin';
                try {
                    const resp = await fetch('/api/avatars/get', { method:'POST', headers:ctx().getRequestHeaders() });
                    const avatars = resp.ok ? await resp.json() : [];
                    avatarsLoaded = true;
                    renderAvatarGrid(avatars);
                    toastr.success(`Аватаров: ${avatars.length}`, '', {timeOut:2000});
                } catch(e) { toastr.error('Ошибка загрузки аватаров', ''); }
                ico.className='fa-solid fa-sync';
            }

            btnRefreshUA.addEventListener('click', () => { avatarsLoaded=false; loadAvatars(); });
            // auto-load when user section becomes visible
            chkUser.addEventListener('change', () => { if(chkUser.checked && !avatarsLoaded) loadAvatars(); });
            if (s.sendUserAvatar) setTimeout(loadAvatars, 0);

            /* char upload */
            charUpFile.addEventListener('change', async (ev) => {
                const file=ev.target.files?.[0]; if(!file) return; ev.target.value='';
                try {
                    const b64 = await readFileB64(file);
                    const compressed = window.compressBase64Image ? await window.compressBase64Image(b64,768,0.8) : b64;
                    const path = await uploadRefImage(compressed, 'char');
                    const ss=iig(); if(!ss) return;
                    if(!ss.charRef) ss.charRef={};
                    ss.charRef.imagePath=path; ss.charRef.imageBase64=''; saveAll();
                    charThumb.src=path; charMeta.textContent='✓ фото загружено';
                    toastr.success('Фото {{char}} загружено', '', {timeOut:2000});
                } catch(err) { toastr.error('Ошибка: '+err.message, ''); }
            });
            charDelBtn.addEventListener('click', () => {
                const ss=iig(); if(!ss) return;
                ss.charRef={name:'',imageBase64:'',imagePath:''}; saveAll();
                charThumb.src=''; charMeta.textContent='Если загружено — заменяет аватар выше';
                toastr.info('{{char}} очищен', '', {timeOut:2000});
            });

            /* user upload */
            userUpFile.addEventListener('change', async (ev) => {
                const file=ev.target.files?.[0]; if(!file) return; ev.target.value='';
                try {
                    const b64=await readFileB64(file);
                    const compressed=window.compressBase64Image ? await window.compressBase64Image(b64,768,0.8) : b64;
                    const path=await uploadRefImage(compressed,'user');
                    const ss=iig(); if(!ss) return;
                    if(!ss.userRef) ss.userRef={};
                    ss.userRef.imagePath=path; ss.userRef.imageBase64=''; saveAll();
                    userThumb.src=path; userMeta.textContent='✓ фото загружено';
                    toastr.success('Фото {{user}} загружено', '', {timeOut:2000});
                } catch(err) { toastr.error('Ошибка: '+err.message, ''); }
            });
            userDelBtn.addEventListener('click', () => {
                const ss=iig(); if(!ss) return;
                ss.userRef={name:'',imageBase64:'',imagePath:''}; saveAll();
                userThumb.src=''; userMeta.textContent='Если загружено — заменяет аватар выше';
                toastr.info('{{user}} очищен', '', {timeOut:2000});
            });

        }, false);
    }

    /* ══════════════════════════════════════════
       SECTION 3 — Vision
    ══════════════════════════════════════════ */
    function buildVisionSection() {
        return accordion('fa-solid fa-eye', 'Vision для авто-описания', body => {
            const s = sw();
            if (!s) { body.appendChild(mk('p',{className:'qs-hint',textContent:'Гардероб не готов'})); return; }

            const inpEp  = mk('input', {type:'text',     className:'text_pole', value:s.visionEndpoint||'', placeholder:'https://api.openai.com'});
            const inpKey = mk('input', {type:'password',  className:'text_pole', value:s.visionApiKey||''});
            const inpMod = mk('input', {type:'text',      className:'text_pole', value:s.visionModel||'',   placeholder:'gpt-4o / claude-opus-4'});

            const btnEye = iconBtn('fa-solid fa-eye', 'Показать/скрыть');
            btnEye.addEventListener('click', () => {
                inpKey.type = inpKey.type==='password' ? 'text' : 'password';
                btnEye.querySelector('i').className = inpKey.type==='password' ? 'fa-solid fa-eye' : 'fa-solid fa-eye-slash';
            });

            body.append(
                rowEl('Endpoint', inpEp),
                rowEl('API Key',  inpKey, btnEye),
                rowEl('Модель',   inpMod)
            );

            const btnTest = actionBtn('fa-solid fa-vial', 'Тест Vision');
            body.appendChild(btnTest);

            /* events */
            inpEp.addEventListener('input',  () => { const s2=sw(); if(s2){s2.visionEndpoint=inpEp.value.trim(); ctx().saveSettingsDebounced(); const m=document.getElementById('sw_vision_endpoint'); if(m)m.value=inpEp.value;} });
            inpKey.addEventListener('input', () => { const s2=sw(); if(s2){s2.visionApiKey=inpKey.value.trim();  ctx().saveSettingsDebounced(); const m=document.getElementById('sw_vision_apikey');   if(m)m.value=inpKey.value;} });
            inpMod.addEventListener('input', () => { const s2=sw(); if(s2){s2.visionModel=inpMod.value.trim();   ctx().saveSettingsDebounced(); const m=document.getElementById('sw_vision_model');    if(m)m.value=inpMod.value;} });

            btnTest.addEventListener('click', async () => {
                const s2=sw(); if(!s2) return;
                const ep=(s2.visionEndpoint||'').trim().replace(/\/$/,'');
                const key=(s2.visionApiKey||'').trim();
                if (!ep||!key) { toastr.warning('Заполните Endpoint и API Key', ''); return; }
                btnTest.innerHTML='<i class="fa-solid fa-spinner fa-spin"></i> Тестирую...';
                btnTest.className='qs-action-btn';
                try {
                    const resp=await fetch(`${ep}/v1/models`,{headers:{'Authorization':`Bearer ${key}`}});
                    if (resp.ok) { btnTest.innerHTML='<i class="fa-solid fa-check"></i> Vision OK'; btnTest.className='qs-action-btn ok'; }
                    else         { btnTest.innerHTML=`<i class="fa-solid fa-xmark"></i> HTTP ${resp.status}`; btnTest.className='qs-action-btn err'; }
                } catch(err) {
                    btnTest.innerHTML=`<i class="fa-solid fa-xmark"></i> ${err.message.slice(0,45)}`; btnTest.className='qs-action-btn err';
                }
                setTimeout(()=>{btnTest.innerHTML='<i class="fa-solid fa-vial"></i> Тест Vision'; btnTest.className='qs-action-btn';}, 3500);
            });

        }, false);
    }

    /* ── helpers ── */
    function readFileB64(file) {
        return new Promise((res,rej) => { const r=new FileReader(); r.onloadend=()=>res(r.result.split(',')[1]); r.onerror=rej; r.readAsDataURL(file); });
    }
    async function uploadRefImage(b64, label) {
        const ts = new Date().toISOString().replace(/[:.]/g,'-');
        const resp = await fetch('/api/images/upload', {
            method:'POST', headers:ctx().getRequestHeaders(),
            body:JSON.stringify({image:b64, format:'jpeg', ch_name:'iig_refs', filename:`iig_ref_${label}_${ts}`})
        });
        if (!resp.ok) throw new Error(`Upload HTTP ${resp.status}`);
        return (await resp.json()).path;
    }

    /* ══════════════════════════════════════════
       Double-tap / double-click on sendbar button
    ══════════════════════════════════════════ */
    /* expose settings builder for vw-panel settings tab */
    /* ══════════════════════════════════════════
       SECTION 4 — Теги одежды (менеджер тегов)
       Как в sillyimages: добавить/переименовать/сменить иконку/удалить.
    ══════════════════════════════════════════ */
    function buildTagsSection() {
        return accordion('fa-solid fa-tags', 'Теги одежды', body => {
            const listEl = mk('div', { className: 'vw-tags-list' });
            const addBtn = mk('button', { className: 'vw-tags-add', innerHTML: '<i class="fa-solid fa-plus"></i> Добавить тег' });
            const hint = mk('p', { className: 'qs-hint', textContent: '«Другое» удалить нельзя — это запасной тег. При удалении тега его наряды переносятся в «Другое».' });

            // Гардероб читает типы «вживую» при следующем рендере, поэтому отдельная синхронизация не нужна —
            // и НЕ зовём _vwSyncFromSettings, иначе пересоберётся вся вкладка настроек и схлопнется аккордеон.
            function renderTags() {
                const core = window._swCore;
                if (!core?.types) { listEl.innerHTML = '<p class="qs-hint">Ядро гардероба ещё грузится…</p>'; return; }
                const types = core.types();
                const icons = core.TYPE_ICONS || [];
                listEl.innerHTML = types.map(t => {
                    const locked = t.id === core.FALLBACK_TYPE;
                    const opts = icons.map(ic => `<button type="button" class="vw-tag-ico-opt ${ic === t.icon ? 'vw-tag-ico-sel' : ''}" data-ico="${ic}" title="${ic}"><i class="fa-solid ${ic}"></i></button>`).join('');
                    return `<div class="vw-tag-block">
                        <div class="vw-tag-row" data-id="${san(t.id)}">
                            <button type="button" class="vw-tag-icon" title="Сменить иконку"><i class="fa-solid ${san(t.icon || 'fa-tag')}"></i></button>
                            <input type="text" class="vw-tag-name text_pole" value="${san(t.label || '')}" maxlength="24" placeholder="Название тега">
                            ${locked ? '<span class="vw-tag-lock" title="Запасной тег — удалить нельзя"><i class="fa-solid fa-lock"></i></span>' : '<button type="button" class="vw-tag-del" title="Удалить тег"><i class="fa-solid fa-trash-can"></i></button>'}
                        </div>
                        <div class="vw-tag-icons" hidden>${opts}</div>
                    </div>`;
                }).join('');

                for (const block of listEl.querySelectorAll('.vw-tag-block')) {
                    const row = block.querySelector('.vw-tag-row');
                    const id = row.dataset.id;
                    const iconsBox = block.querySelector('.vw-tag-icons');
                    row.querySelector('.vw-tag-icon').addEventListener('click', () => {
                        const willShow = iconsBox.hidden;
                        for (const b of listEl.querySelectorAll('.vw-tag-icons')) b.hidden = true;
                        iconsBox.hidden = !willShow;
                    });
                    for (const opt of iconsBox.querySelectorAll('.vw-tag-ico-opt'))
                        opt.addEventListener('click', () => { window._swCore.setTypeIcon(id, opt.dataset.ico); renderTags(); });
                    const nameInp = row.querySelector('.vw-tag-name');
                    nameInp.addEventListener('input', () => window._swCore.renameType(id, nameInp.value)); // без перерисовки — не теряем фокус
                    nameInp.addEventListener('change', () => { const v = nameInp.value.trim() || 'Тег'; window._swCore.renameType(id, v); nameInp.value = v; });
                    row.querySelector('.vw-tag-del')?.addEventListener('click', () => {
                        const moved = window._swCore.deleteType(id);
                        renderTags();
                        toastr.info(`Тег удалён${moved ? ` · ${moved} нарядов → «Другое»` : ''}`, 'Гардероб', { timeOut: 2500 });
                    });
                }
            }

            addBtn.addEventListener('click', () => { if (window._swCore?.addType) { window._swCore.addType(); renderTags(); } });
            body.append(listEl, addBtn, hint);
            renderTags();
        });
    }

    /* ── Стили: включить в одно касание, править, картинка-референс ── */
    // Те же данные и функции, что у раздела «Стили» в основных настройках (Module 2).
    function buildStylesSection() {
        return accordion('fa-solid fa-palette', 'Стили', body => {
            const s = iig();
            if (!s) { body.appendChild(mk('p', { className:'qs-hint', textContent:'Расширение не готово' })); return; }
            let editingId = null;
            const list = mk('div', { className:'qs-style-list' });
            const addBtn = actionBtn('fa-solid fa-plus', 'Новый стиль');
            body.append(
                mk('p', { className:'qs-hint', textContent:'Нажми на стиль, чтобы включить. Активный стиль заменяет style из тега.' }),
                list, addBtn,
            );

            // Сохранить и обновить раздел «Стили» в основных настройках, если он открыт.
            const sync = () => { saveAll(); try { renderStyleSection(); } catch (e) { /* настройки ещё не отрисованы */ } };

            function render() {
                list.innerHTML = '';
                const none = mk('div', { className:'qs-style-row' + (!s.activeStyleId ? ' qs-style-on' : '') });
                none.innerHTML = '<i class="fa-solid fa-ban qs-style-mark"></i><div class="qs-style-text"><b>Без стиля</b><small>берётся из тега</small></div>';
                none.addEventListener('click', () => { s.activeStyleId = ''; sync(); render(); });
                list.appendChild(none);

                for (const st of getStyles(s)) {
                    const on = st.id === s.activeStyleId;
                    const row = mk('div', { className:'qs-style-row' + (on ? ' qs-style-on' : '') });
                    const mark = mk('i', { className:`fa-solid ${on ? 'fa-circle-check' : 'fa-circle'} qs-style-mark` });
                    const text = mk('div', { className:'qs-style-text' });
                    const preview = String(st.value || '').replace(/\s+/g, ' ').trim();
                    text.append(
                        mk('b', { textContent: st.name }),
                        mk('small', { textContent: preview ? (preview.length > 60 ? preview.slice(0, 60) + '…' : preview) : 'пустой стиль' }),
                    );
                    const edit = iconBtn('fa-solid fa-pen', 'Править');
                    edit.addEventListener('click', (e) => { e.stopPropagation(); editingId = editingId === st.id ? null : st.id; render(); });
                    row.append(mark);
                    if (st.imagePath) row.append(mk('img', { className:'qs-style-thumb', src: st.imagePath, alt:'' }));
                    row.append(text, edit);
                    row.addEventListener('click', () => { s.activeStyleId = on ? '' : st.id; sync(); render(); });
                    list.appendChild(row);
                    if (editingId === st.id) list.appendChild(buildEditor(st));
                }
            }

            function buildEditor(st) {
                const ed = mk('div', { className:'qs-style-editor' });
                const name = mk('input', { type:'text', className:'text_pole', value: st.name, placeholder:'Название' });
                name.addEventListener('input', () => { st.name = name.value; sync(); });
                name.addEventListener('change', render); // подпись в строке — после ухода с поля
                const val = mk('textarea', { className:'text_pole', rows:4, value: st.value, placeholder:'semi_realism, muted colors, soft lighting' });
                val.addEventListener('input', () => { st.value = val.value; sync(); });
                val.addEventListener('change', render);

                const imgRow = mk('div', { className:'qs-style-img-row' });
                imgRow.append(st.imagePath
                    ? mk('img', { className:'qs-style-img', src: st.imagePath, alt:'' })
                    : mk('div', { className:'qs-style-img qs-style-img-empty', innerHTML:'<i class="fa-solid fa-image"></i>' }));
                const upload = mk('label', { className:'qs-action-btn', innerHTML:`<i class="fa-solid fa-upload"></i> ${st.imagePath ? 'Заменить' : 'Картинка стиля'}` });
                const file = mk('input', { type:'file', accept:'image/*' });
                file.style.display = 'none';
                upload.appendChild(file);
                file.addEventListener('change', async () => {
                    const f = file.files?.[0];
                    if (!f) return;
                    try {
                        const raw = await new Promise((res, rej) => { const r = new FileReader(); r.onloadend = () => res(r.result.split(',')[1]); r.onerror = rej; r.readAsDataURL(f); });
                        const jpeg = await compressBase64Image(raw, 1024, 0.85);
                        st.imagePath = await saveRefImageToFile(jpeg, `style_${st.name}`);
                        sync(); render();
                        toastr.success('Картинка стиля сохранена', '', { timeOut: 1500 });
                    } catch (err) { toastr.error('Не удалось загрузить: ' + err.message, ''); }
                });
                imgRow.append(upload);
                if (st.imagePath) {
                    const rm = actionBtn('fa-solid fa-xmark', 'Убрать');
                    rm.addEventListener('click', () => { st.imagePath = ''; sync(); render(); });
                    imgRow.append(rm);
                }

                const del = actionBtn('fa-solid fa-trash', 'Удалить стиль');
                del.classList.add('qs-style-del');
                del.addEventListener('click', () => {
                    if (!confirm(`Удалить стиль «${st.name}»?`)) return;
                    s.styles = s.styles.filter(x => x.id !== st.id);
                    if (s.activeStyleId === st.id) s.activeStyleId = '';
                    editingId = null;
                    sync(); render();
                });
                ed.append(name, val, imgRow, del);
                return ed;
            }

            addBtn.addEventListener('click', () => {
                const st = { id: makeStyleId(), name: `Стиль ${getStyles(s).length + 1}`, value: '', imagePath: '' };
                s.styles.push(st);
                editingId = st.id;
                sync(); render();
            });
            render();
        });
    }

    window._qsBuildSettingsContent = function(container) {
        const wrap = mk('div', { className: 'qs-body' });
        wrap.style.cssText = 'padding:0;overflow:visible;';
        wrap.append(buildApiSection(), buildStylesSection(), buildRefsSection(), buildVisionSection(), buildTagsSection());
        container.appendChild(wrap);
    };

    function patchButton() {
        const btn = document.getElementById('vw-panel-btn');
        if (!btn || btn._qsPatched) return;
        btn._qsPatched = true;
        btn.title = 'Гардероб & НПС';
    }

    /* ── init ── */
    const _ctx = SillyTavern.getContext();
    _ctx.eventSource.on(_ctx.event_types.APP_READY, () => {
        setTimeout(patchButton, 1500);
    });
    _ctx.eventSource.on(_ctx.event_types.CHAT_CHANGED, () => {
        setTimeout(patchButton, 600);
    });
    // Fallback retries
    [2000, 4000, 7000].forEach(t => setTimeout(patchButton, t));

})();
