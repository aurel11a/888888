/**
 * Кнопка гардероба у поля ввода и шторка: наряды персонажа и Юзера, избранное, каталог.
 *
 * Шторка создаётся при открытии и удаляется при закрытии: ничего не висит в странице
 * и не перерисовывается в фоне (размытие и вечные анимации грели айфоны).
 */

import { getSettings } from './settings.js';
import { getCurrentCharacterReferenceKey } from './references.js';
import { saveCompressedImage, sanitizeForHtml as san } from './utils.js';
import {
    OUTFIT_CATEGORIES, outfitCategory, sideKey, getOutfits, getWornOutfit, setWornOutfit,
    addOutfit, updateOutfit, removeOutfit, getFavorites, isFavorite, toggleFavorite, wearFavorite,
} from './wardrobe.js';

const COSMETICS_SVG = `<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor"><path d="M475.415,117.769l3.126-73.358c0.499-11.705-3.689-22.808-11.796-31.267C458.64,4.686,447.725,0.028,436.01,0.028c-11.715,0-22.631,4.659-30.737,13.117c-8.105,8.458-12.294,19.562-11.796,31.266l3.127,73.358H0v49.198h512v-49.198H475.415z M441.997,117.769h-11.975l-3.187-74.779c-0.146-3.407,1.531-5.687,2.544-6.744c1.013-1.057,3.222-2.83,6.631-2.83c3.409,0,5.617,1.773,6.63,2.829s2.69,3.338,2.544,6.745L441.997,117.769z"/><path d="M475.835,200.355H36.143L17.239,427.204c-3.803,45.632,32.208,84.768,77.997,84.768h321.505c45.79,0,81.799-39.136,77.998-84.768L475.835,200.355z M323.025,300.149c18.263-3.73,33.47-2.522,33.47-2.522s3.923,48.917-23.829,76.668c-7.782,7.782-17.227,13.072-26.791,16.657c10.96-16.661,20.875-38.693,20.875-63.89C326.75,317.605,325.349,308.598,323.025,300.149z M155.504,297.627c0,0,15.208-1.209,33.47,2.522c-2.324,8.448-3.725,17.456-3.725,26.913c0,25.199,9.914,47.23,20.875,63.89c-9.564-3.586-19.011-8.877-26.791-16.657C151.581,346.544,155.504,297.627,155.504,297.627z M184.938,435.486c-39.246,0-71.062-37.363-71.062-37.363s9.899-11.608,25.45-21.884c4.33,7.617,9.709,14.978,16.397,21.664c13.691,13.69,31.657,23.41,53.398,28.889c2.229,0.562,4.429,1.056,6.599,1.501C206.407,432.536,195.966,435.486,184.938,435.486z M256,398.123c0,0-37.364-31.815-37.364-71.062S256,255.999,256,255.999s37.364,31.815,37.364,71.062S256,398.123,256,398.123z M327.061,435.486c-11.028,0-21.469-2.95-30.782-7.193c2.169-0.445,4.37-0.939,6.598-1.501c21.742-5.479,39.708-15.198,53.398-28.889c6.686-6.686,12.065-14.047,16.397-21.664c15.552,10.276,25.45,21.884,25.45,21.884S366.308,435.486,327.061,435.486z"/></svg>`;

const CATALOG_BASE = 'https://raw.githubusercontent.com/aurel11a/777777/main/';
const IMAGE_FOLDER = 'wardrobe';
const PAGE_SIZE = 12;

const state = {
    tab: 'char',          // 'char' | 'user' | 'fav' | 'catalog'
    filter: 'all',
    page: 0,
    editingId: null,
    catalog: { index: null, loading: false, error: '', loadedAt: 0 },
    catalogGender: (() => { try { return localStorage.getItem('chamber_catalog_gender') === 'male' ? 'male' : 'female'; } catch (_e) { return 'female'; } })(),
    catalogQuery: '',
    busy: new Set(),
};
let searchTimer = null;

// ----- Кнопка у поля ввода -----

function injectButton() {
    let btn = document.getElementById('chamber-wardrobe-btn');
    if (!btn) {
        btn = document.createElement('div');
        btn.id = 'chamber-wardrobe-btn';
        btn.className = 'interactable';
        btn.title = 'Гардероб';
        btn.tabIndex = 0;
        btn.innerHTML = COSMETICS_SVG;
        btn.addEventListener('click', (e) => { e.stopPropagation(); toggleSheet(); });
    }
    const container = document.getElementById('leftSendForm') || document.getElementById('send_form');
    if (container && !container.contains(btn)) container.appendChild(btn);
}

export function initWardrobeUi() {
    const context = SillyTavern.getContext();
    injectButton();
    context.eventSource.on(context.event_types.CHAT_CHANGED, () => {
        injectButton();
        if (document.getElementById('chamber-sheet')) render();
    });
}

// ----- Шторка -----

function toggleSheet() {
    if (document.getElementById('chamber-sheet')) closeSheet();
    else openSheet();
}

function onKey(e) { if (e.key === 'Escape') closeSheet(); }

function openSheet() {
    const backdrop = document.createElement('div');
    backdrop.id = 'chamber-sheet';
    backdrop.className = 'chamber-backdrop';
    backdrop.innerHTML = '<div class="chamber-panel"><div class="chamber-head"></div><div class="chamber-body"></div></div>';
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeSheet(); });
    // На <html>, как остальные оверлеи: у body в ST position: fixed.
    document.documentElement.appendChild(backdrop);
    document.addEventListener('keydown', onKey);
    state.editingId = null;
    render();
}

function closeSheet() {
    document.getElementById('chamber-sheet')?.remove();
    document.removeEventListener('keydown', onKey);
}

function charName() {
    const context = SillyTavern.getContext();
    return context.name2 && getCurrentCharacterReferenceKey() !== 'no-character' ? context.name2 : '';
}

async function render() {
    const root = document.getElementById('chamber-sheet');
    if (!root) return;
    const head = root.querySelector('.chamber-head');
    const body = root.querySelector('.chamber-body');
    const name = charName();
    const tabs = [
        ['char', 'fa-robot', name || 'Персонаж'],
        ['user', 'fa-user', 'Юзер'],
        ['fav', 'fa-heart', 'Избранное'],
        ['catalog', 'fa-store', 'Каталог'],
    ];
    head.innerHTML = `<div class="chamber-tabs">${tabs.map(([id, icon, label]) =>
        `<button class="chamber-tab ${state.tab === id ? 'on' : ''}" data-tab="${id}"><i class="fa-solid ${icon}"></i><span>${san(label)}</span></button>`).join('')}</div>
        <button class="chamber-close" title="Закрыть"><i class="fa-solid fa-xmark"></i></button>`;
    head.querySelector('.chamber-close').addEventListener('click', closeSheet);
    for (const b of head.querySelectorAll('.chamber-tab'))
        b.addEventListener('click', () => { state.tab = b.dataset.tab; state.filter = 'all'; state.page = 0; state.editingId = null; render(); });

    if (state.tab === 'char' || state.tab === 'user') await renderSide(body, state.tab);
    else if (state.tab === 'fav') renderFavorites(body);
    else renderCatalog(body);
}

// ----- Наряды персонажа / Юзера -----

function categoryChips(items, current) {
    const counts = {};
    for (const it of items) counts[outfitCategory(it.category).id] = (counts[outfitCategory(it.category).id] || 0) + 1;
    if (current !== 'all' && !counts[current]) state.filter = current = 'all';
    if (items.length < 2) return '';
    return `<div class="chamber-chips"><button class="chamber-chip ${current === 'all' ? 'on' : ''}" data-cat="all">Все <b>${items.length}</b></button>${
        OUTFIT_CATEGORIES.filter(c => counts[c.id]).map(c =>
            `<button class="chamber-chip ${current === c.id ? 'on' : ''}" data-cat="${c.id}"><i class="fa-solid ${c.icon}"></i>${san(c.label)} <b>${counts[c.id]}</b></button>`).join('')}</div>`;
}

function bindChips(body) {
    for (const c of body.querySelectorAll('.chamber-chip'))
        c.addEventListener('click', () => { state.filter = c.dataset.cat; state.page = 0; render(); });
}

function pager(total) {
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    state.page = Math.min(Math.max(state.page, 0), pages - 1);
    return pages > 1 ? `<div class="chamber-pager"><button data-pg="-1" ${state.page === 0 ? 'disabled' : ''}><i class="fa-solid fa-chevron-left"></i></button><span>${state.page + 1} / ${pages}</span><button data-pg="1" ${state.page >= pages - 1 ? 'disabled' : ''}><i class="fa-solid fa-chevron-right"></i></button></div>` : '';
}

function bindPager(body) {
    for (const b of body.querySelectorAll('.chamber-pager button'))
        b.addEventListener('click', () => { state.page += Number(b.dataset.pg); render(); });
}

async function renderSide(body, kind) {
    const settings = getSettings();
    if (kind === 'char' && getCurrentCharacterReferenceKey() === 'no-character') {
        body.innerHTML = '<div class="chamber-empty"><i class="fa-solid fa-user-slash"></i><p>Открой чат с персонажем</p></div>';
        return;
    }
    const key = await sideKey(kind, settings);
    const all = getOutfits(kind, key, settings).slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    const worn = getWornOutfit(kind, key, settings);
    const items = all.filter(o => state.filter === 'all' || outfitCategory(o.category).id === state.filter);
    const pageItems = items.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE);

    body.innerHTML = `
        <div class="chamber-worn">${worn
            ? `<img src="${san(worn.imagePath)}" alt=""><div><small>Сейчас надето в этом чате</small><b>${san(worn.name)}</b></div><button class="chamber-btn chamber-unwear"><i class="fa-solid fa-xmark"></i> Снять</button>`
            : '<div><small>Сейчас надето в этом чате</small><b>ничего</b></div>'}
            <label class="chamber-btn chamber-main chamber-upload"><i class="fa-solid fa-plus"></i> Добавить<input type="file" accept="image/*" hidden></label>
        </div>
        ${categoryChips(all, state.filter)}
        ${all.length ? `<div class="chamber-grid">${pageItems.map(o => outfitCard(o, worn?.id === o.id)).join('')}</div>${pager(items.length)}`
            : '<div class="chamber-empty"><i class="fa-solid fa-shirt"></i><p>Нарядов пока нет<br><small>«Добавить» или вкладка «Каталог»</small></p></div>'}`;

    body.querySelector('.chamber-unwear')?.addEventListener('click', () => { setWornOutfit(kind, key, null); render(); });
    body.querySelector('.chamber-upload input').addEventListener('change', (e) => uploadOutfit(e, kind, key));
    bindChips(body);
    bindPager(body);
    for (const card of body.querySelectorAll('.chamber-card')) {
        const id = card.dataset.id;
        const item = all.find(o => o.id === id);
        card.querySelector('.chamber-card-img').addEventListener('click', () => {
            setWornOutfit(kind, key, worn?.id === id ? null : id);
            render();
        });
        card.querySelector('.chamber-like').addEventListener('click', () => { toggleFavorite(item); render(); });
        card.querySelector('.chamber-edit').addEventListener('click', () => { state.editingId = state.editingId === id ? null : id; render(); });
    }
    const editing = state.editingId && all.find(o => o.id === state.editingId);
    if (editing) mountEditor(body, kind, key, editing);
}

function outfitCard(o, on) {
    const cat = outfitCategory(o.category);
    return `<div class="chamber-card ${on ? 'on' : ''}" data-id="${san(o.id)}">
        <div class="chamber-card-img" title="${on ? 'Снять' : 'Надеть'}">
            <img src="${san(o.imagePath)}" alt="" loading="lazy" decoding="async">
            ${on ? '<span class="chamber-badge"><i class="fa-solid fa-check"></i></span>' : ''}
            <span class="chamber-cat" title="${san(cat.label)}"><i class="fa-solid ${cat.icon}"></i></span>
        </div>
        <div class="chamber-card-foot">
            <span title="${san(o.description || o.name)}">${san(o.name)}</span>
            <button class="chamber-icon chamber-like ${isFavorite(o) ? 'on' : ''}" title="В избранное"><i class="fa-${isFavorite(o) ? 'solid' : 'regular'} fa-heart"></i></button>
            <button class="chamber-icon chamber-edit" title="Править"><i class="fa-solid fa-pen"></i></button>
        </div>
    </div>`;
}

function mountEditor(body, kind, key, item) {
    const ed = document.createElement('div');
    ed.className = 'chamber-editor';
    ed.innerHTML = `
        <div class="chamber-editor-head"><img src="${san(item.imagePath)}" alt=""><b>Правка наряда</b></div>
        <input type="text" class="text_pole chamber-ed-name" value="${san(item.name)}" placeholder="Название">
        <select class="text_pole chamber-ed-cat">${OUTFIT_CATEGORIES.map(c => `<option value="${c.id}" ${outfitCategory(item.category).id === c.id ? 'selected' : ''}>${san(c.label)}</option>`).join('')}</select>
        <textarea class="text_pole chamber-ed-desc" rows="4" placeholder="Описание для промпта (лучше на английском): что это, цвет, ткань, детали">${san(item.description)}</textarea>
        <div class="chamber-editor-actions">
            <button class="chamber-btn chamber-main chamber-ed-save"><i class="fa-solid fa-check"></i> Готово</button>
            <button class="chamber-btn chamber-danger chamber-ed-del"><i class="fa-solid fa-trash"></i> Удалить</button>
        </div>`;
    body.prepend(ed);
    ed.querySelector('.chamber-ed-save').addEventListener('click', () => {
        updateOutfit(kind, key, item.id, {
            name: ed.querySelector('.chamber-ed-name').value || item.name,
            category: ed.querySelector('.chamber-ed-cat').value,
            description: ed.querySelector('.chamber-ed-desc').value,
        });
        state.editingId = null;
        render();
    });
    ed.querySelector('.chamber-ed-del').addEventListener('click', () => {
        if (!confirm(`Удалить «${item.name}» из гардероба?`)) return;
        removeOutfit(kind, key, item.id);
        state.editingId = null;
        render();
    });
    ed.querySelector('.chamber-ed-name').focus();
}

function storeImage(source, label) {
    return saveCompressedImage(source, { folder: IMAGE_FOLDER, label });
}

async function uploadOutfit(e, kind, key) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
        const imagePath = await storeImage(file, file.name);
        const item = addOutfit(kind, key, { name: file.name.replace(/\.[^.]+$/, ''), imagePath });
        state.editingId = item.id; // сразу дать вписать название и описание
        render();
    } catch (error) {
        toastr.error(`Не удалось загрузить: ${error.message || error}`, 'Гардероб');
    }
}

// ----- Избранное -----

function renderFavorites(body) {
    const favorites = getFavorites().slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    const items = favorites.filter(f => state.filter === 'all' || outfitCategory(f.category).id === state.filter);
    const pageItems = items.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE);
    const name = charName();
    body.innerHTML = favorites.length ? `
        <p class="chamber-hint">Понравившиеся вещи. Надень на кого угодно — вещь добавится в его гардероб.</p>
        ${categoryChips(favorites, state.filter)}
        <div class="chamber-grid">${pageItems.map(f => `
            <div class="chamber-card" data-id="${san(f.id)}">
                <div class="chamber-card-img"><img src="${san(f.imagePath)}" alt="" loading="lazy" decoding="async">
                    <span class="chamber-cat"><i class="fa-solid ${outfitCategory(f.category).icon}"></i></span></div>
                <div class="chamber-card-foot"><span title="${san(f.description || f.name)}">${san(f.name)}</span>
                    <button class="chamber-icon chamber-like on" title="Убрать из избранного"><i class="fa-solid fa-heart"></i></button></div>
                <div class="chamber-card-actions">
                    <button class="chamber-btn chamber-wear" data-side="char" ${name ? '' : 'disabled'}><i class="fa-solid fa-robot"></i> ${san(name || 'Персонаж')}</button>
                    <button class="chamber-btn chamber-wear" data-side="user"><i class="fa-solid fa-user"></i> Юзер</button>
                </div>
            </div>`).join('')}</div>${pager(items.length)}`
        : '<div class="chamber-empty"><i class="fa-regular fa-heart"></i><p>Избранное пусто<br><small>Нажми ♥ на понравившейся вещи</small></p></div>';
    bindChips(body);
    bindPager(body);
    for (const card of body.querySelectorAll('.chamber-card')) {
        const fav = favorites.find(f => f.id === card.dataset.id);
        card.querySelector('.chamber-like').addEventListener('click', () => { toggleFavorite(fav); render(); });
        for (const b of card.querySelectorAll('.chamber-wear'))
            b.addEventListener('click', async () => {
                const kind = b.dataset.side;
                wearFavorite(kind, await sideKey(kind), fav);
                toastr.success(`«${fav.name}» надето на ${kind === 'char' ? charName() : 'Юзера'}`, 'Гардероб', { timeOut: 2000 });
                render();
            });
    }
}

// ----- Каталог -----

async function loadCatalog(force = false) {
    const c = state.catalog;
    if (c.loading || (!force && c.index && Date.now() - c.loadedAt < 60_000)) return;
    c.loading = true; c.error = '';
    render();
    try {
        // Метка меняется раз в минуту: между открытиями файл берётся из кэша браузера.
        const stamp = force ? Date.now() : Math.floor(Date.now() / 60_000);
        const resp = await fetch(`${CATALOG_BASE}index.json?t=${stamp}`, { signal: AbortSignal.timeout(15_000), ...(force ? { cache: 'no-store' } : {}) });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const index = await resp.json();
        c.index = { ...index, items: Array.isArray(index.items) ? index.items : [] };
        c.loadedAt = Date.now();
    } catch (error) {
        c.error = error?.name === 'TimeoutError' || /failed to fetch|load failed|networkerror/i.test(String(error?.message))
            ? 'GitHub не отвечает — проверь интернет (или VPN) и нажми ⟳'
            : error.message || String(error);
    } finally {
        c.loading = false;
        if (state.tab === 'catalog') render();
    }
}

function renderCatalog(body) {
    const c = state.catalog;
    if (!c.index && !c.loading && !c.error) { loadCatalog(); return; }
    const name = charName();
    const all = (c.index?.items || []).slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    const pool = all.filter(it => !it.gender || it.gender === 'unisex' || it.gender === state.catalogGender);
    const q = state.catalogQuery.trim().toLowerCase();
    const filtered = pool.filter(it => (state.filter === 'all' || outfitCategory(it.type).id === state.filter)
        && (!q || `${it.name || ''} ${it.description || ''}`.toLowerCase().includes(q)));
    const pageItems = filtered.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE);
    const chipsSource = pool.map(it => ({ category: it.type }));

    body.innerHTML = `
        <div class="chamber-row">
            <button class="chamber-btn chamber-gender ${state.catalogGender === 'female' ? 'on' : ''}" data-g="female"><i class="fa-solid fa-person-dress"></i> Женское</button>
            <button class="chamber-btn chamber-gender ${state.catalogGender === 'male' ? 'on' : ''}" data-g="male"><i class="fa-solid fa-person"></i> Мужское</button>
            <button class="chamber-icon chamber-refresh" title="Обновить"><i class="fa-solid fa-rotate ${c.loading ? 'fa-spin' : ''}"></i></button>
        </div>
        <input type="search" class="text_pole chamber-search" placeholder="Поиск по каталогу" value="${san(state.catalogQuery)}">
        ${categoryChips(chipsSource, state.filter)}
        ${c.error && !all.length ? `<div class="chamber-empty"><i class="fa-solid fa-cloud-bolt"></i><p>Каталог не загрузился<br><small>${san(c.error)}</small></p></div>`
            : c.loading && !all.length ? '<div class="chamber-empty"><i class="fa-solid fa-spinner fa-spin"></i><p>Загружаю…</p></div>'
            : !filtered.length ? '<div class="chamber-empty"><i class="fa-solid fa-store"></i><p>Ничего не нашлось</p></div>'
            : `<div class="chamber-grid">${pageItems.map(it => {
                const busy = state.busy.has(it.id);
                return `<div class="chamber-card" data-id="${san(it.id)}">
                    <div class="chamber-card-img"><img src="${san(CATALOG_BASE + (it.thumb || it.image || ''))}" alt="" loading="lazy" decoding="async">
                        <span class="chamber-cat"><i class="fa-solid ${outfitCategory(it.type).icon}"></i></span></div>
                    <div class="chamber-card-foot"><span title="${san(it.description || it.name)}">${san(it.name)}</span>
                        <button class="chamber-icon chamber-cat-like" title="В избранное" ${busy ? 'disabled' : ''}><i class="fa-regular fa-heart"></i></button></div>
                    <div class="chamber-card-actions">
                        <button class="chamber-btn chamber-cat-wear" data-side="char" ${busy || !name ? 'disabled' : ''} title="Надеть на персонажа"><i class="fa-solid ${busy ? 'fa-spinner fa-spin' : 'fa-robot'}"></i> ${san(name || 'Персонаж')}</button>
                        <button class="chamber-btn chamber-cat-wear" data-side="user" ${busy ? 'disabled' : ''} title="Надеть на Юзера"><i class="fa-solid fa-user"></i> Юзер</button>
                    </div>
                </div>`;
            }).join('')}</div>${pager(filtered.length)}`}`;

    for (const b of body.querySelectorAll('.chamber-gender'))
        b.addEventListener('click', () => {
            state.catalogGender = b.dataset.g;
            try { localStorage.setItem('chamber_catalog_gender', state.catalogGender); } catch (_e) { /* приватный режим */ }
            state.filter = 'all'; state.page = 0; render();
        });
    body.querySelector('.chamber-refresh').addEventListener('click', () => loadCatalog(true));
    const search = body.querySelector('.chamber-search');
    search.addEventListener('input', () => {
        state.catalogQuery = search.value; state.page = 0;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            render().then(() => {
                const again = document.querySelector('#chamber-sheet .chamber-search');
                if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
            });
        }, 250);
    });
    bindChips(body);
    bindPager(body);
    for (const card of body.querySelectorAll('.chamber-card')) {
        const it = all.find(x => x.id === card.dataset.id);
        card.querySelector('.chamber-cat-like').addEventListener('click', () => importCatalogItem(it, 'fav'));
        for (const b of card.querySelectorAll('.chamber-cat-wear')) b.addEventListener('click', () => importCatalogItem(it, b.dataset.side));
    }
}

async function importCatalogItem(item, target) {
    if (state.busy.has(item.id)) return;
    state.busy.add(item.id);
    render();
    try {
        const resp = await fetch(CATALOG_BASE + item.image);
        if (!resp.ok) throw new Error(`картинка не загрузилась (HTTP ${resp.status})`);
        const imagePath = await storeImage(await resp.blob(), item.name || 'catalog');
        const data = { name: item.name, description: item.description, imagePath, category: item.type, gender: item.gender, catalogId: item.id };
        if (target === 'fav') {
            if (!isFavorite(data)) toggleFavorite(data);
            toastr.success(`«${item.name}» в избранном`, 'Каталог', { timeOut: 2000 });
        } else {
            const key = await sideKey(target);
            const outfit = addOutfit(target, key, data);
            setWornOutfit(target, key, outfit.id);
            toastr.success(`«${item.name}» надето на ${target === 'char' ? charName() : 'Юзера'}`, 'Каталог', { timeOut: 2000 });
        }
    } catch (error) {
        toastr.error(`Не удалось добавить: ${error.message || error}`, 'Каталог');
    } finally {
        state.busy.delete(item.id);
        render();
    }
}
