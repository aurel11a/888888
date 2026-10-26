/**
 * Гардероб поверх библиотеки персонажей.
 *
 * Наряд — элемент внешности с картинкой (appearanceItems) с флагом `outfit` и полями
 * name / category / gender / catalogId. Наряды есть у персонажей и у Юзера (персоны).
 * Что надето — своё в каждом чате: settings.wardrobeWorn[chatId]['char:<key>'] = id.
 * Избранное — полка лайкнутых вещей, их можно надеть на любого.
 * В генерацию надетый наряд уходит обычным референсом (см. references.js),
 * в чат для LLM — строкой «[Имя is currently wearing: …]».
 */

import { getSettings, saveSettings, iigLog } from './settings.js';
import {
    getCharacterLibraryEntry,
    getCurrentCharacterReferenceKey,
    getCurrentUserReferenceKey,
} from './references.js';
import { normalizeStoredImagePath } from './utils.js';

export const OUTFIT_CATEGORIES = Object.freeze([
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
]);

export function outfitCategory(id) {
    return OUTFIT_CATEGORIES.find(c => c.id === id) || OUTFIT_CATEGORIES[OUTFIT_CATEGORIES.length - 1];
}

const OUTFIT_PROMPT_KEY = 'chamber_outfits';

function makeId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function currentChatId() {
    try {
        const context = SillyTavern.getContext();
        return (typeof context.getCurrentChatId === 'function' ? context.getCurrentChatId() : null) || 'global';
    } catch (_error) {
        return 'global';
    }
}

/** Ключ стороны: 'char' — текущий персонаж, 'user' — текущая персона. */
export async function sideKey(kind, settings = getSettings()) {
    return kind === 'user' ? getCurrentUserReferenceKey(settings) : getCurrentCharacterReferenceKey();
}

function wornBucket(settings = getSettings(), chatId = currentChatId()) {
    if (!settings.wardrobeWorn || typeof settings.wardrobeWorn !== 'object') settings.wardrobeWorn = {};
    if (!settings.wardrobeWorn[chatId] || typeof settings.wardrobeWorn[chatId] !== 'object') settings.wardrobeWorn[chatId] = {};
    return settings.wardrobeWorn[chatId];
}

export function getOutfits(kind, key, settings = getSettings()) {
    const entry = getCharacterLibraryEntry(kind, key, settings, { create: false });
    return (entry?.appearanceItems || []).filter(item => item.outfit && item.type === 'image');
}

export function getWornOutfit(kind, key, settings = getSettings(), chatId = currentChatId()) {
    const id = settings.wardrobeWorn?.[chatId]?.[`${kind}:${key}`];
    if (!id) return null;
    return getOutfits(kind, key, settings).find(item => item.id === id) || null;
}

export function setWornOutfit(kind, key, itemId, settings = getSettings(), chatId = currentChatId()) {
    const bucket = wornBucket(settings, chatId);
    const slot = `${kind}:${key}`;
    if (itemId) {
        bucket[slot] = itemId;
        const item = getOutfits(kind, key, settings).find(o => o.id === itemId);
        if (item) item.lastWorn = Date.now();
    } else {
        delete bucket[slot];
    }
    saveSettings();
    updateOutfitInjection();
}

/** Добавить наряд; одна и та же картинка у одной стороны не дублируется. */
export function addOutfit(kind, key, data, settings = getSettings()) {
    const entry = getCharacterLibraryEntry(kind, key, settings);
    const imagePath = normalizeStoredImagePath(data.imagePath);
    const existing = entry.appearanceItems.find(item => item.outfit && (
        (imagePath && item.imagePath === imagePath) || (data.catalogId && item.catalogId === data.catalogId)));
    if (existing) return existing;
    const item = {
        id: makeId('outfit'),
        type: 'image',
        enabled: true,
        outfit: true,
        imagePath,
        name: String(data.name || 'Наряд').trim(),
        description: String(data.description || '').trim(),
        category: outfitCategory(data.category).id,
        gender: String(data.gender || ''),
        catalogId: String(data.catalogId || ''),
        addedAt: Date.now(),
    };
    entry.appearanceItems.push(item);
    saveSettings();
    return item;
}

export function updateOutfit(kind, key, itemId, patch, settings = getSettings()) {
    const item = getOutfits(kind, key, settings).find(o => o.id === itemId);
    if (!item) return null;
    for (const field of ['name', 'description', 'category']) {
        if (Object.hasOwn(patch, field)) item[field] = field === 'category' ? outfitCategory(patch[field]).id : String(patch[field] || '').trim();
    }
    saveSettings();
    updateOutfitInjection();
    return item;
}

/** Удалить наряд и снять его во всех чатах. Файл картинки не трогаем: он может быть в избранном. */
export function removeOutfit(kind, key, itemId, settings = getSettings()) {
    const entry = getCharacterLibraryEntry(kind, key, settings, { create: false });
    if (!entry) return false;
    entry.appearanceItems = entry.appearanceItems.filter(item => item.id !== itemId);
    for (const bucket of Object.values(settings.wardrobeWorn || {})) {
        if (bucket?.[`${kind}:${key}`] === itemId) delete bucket[`${kind}:${key}`];
    }
    saveSettings();
    updateOutfitInjection();
    return true;
}

// ----- Избранное -----

export function getFavorites(settings = getSettings()) {
    if (!Array.isArray(settings.wardrobeFavorites)) settings.wardrobeFavorites = [];
    return settings.wardrobeFavorites;
}

export function isFavorite(item, settings = getSettings()) {
    const path = normalizeStoredImagePath(item?.imagePath);
    return getFavorites(settings).some(fav => fav.imagePath === path);
}

export function toggleFavorite(item, settings = getSettings()) {
    const favorites = getFavorites(settings);
    const path = normalizeStoredImagePath(item?.imagePath);
    const index = favorites.findIndex(fav => fav.imagePath === path);
    if (index >= 0) {
        favorites.splice(index, 1);
    } else {
        favorites.push({
            id: makeId('fav'),
            imagePath: path,
            name: item.name || 'Наряд',
            description: item.description || '',
            category: outfitCategory(item.category).id,
            gender: item.gender || '',
            catalogId: item.catalogId || '',
            addedAt: Date.now(),
        });
    }
    saveSettings();
    return index < 0;
}

/** Надеть вещь из избранного на сторону: добавить в её гардероб (тот же файл) и надеть. */
export function wearFavorite(kind, key, favorite, settings = getSettings()) {
    const item = addOutfit(kind, key, favorite, settings);
    setWornOutfit(kind, key, item.id, settings);
    return item;
}

// ----- Текст «что надето» для LLM -----

export async function updateOutfitInjection() {
    try {
        const context = SillyTavern.getContext();
        if (typeof context.setExtensionPrompt !== 'function') return;
        const settings = getSettings();
        const lines = [];
        const charKey = getCurrentCharacterReferenceKey();
        if (charKey !== 'no-character') {
            const worn = getWornOutfit('char', charKey, settings);
            if (worn?.description) lines.push(`[${context.name2 || 'The character'} is currently wearing: ${worn.description}]`);
        }
        const userWorn = getWornOutfit('user', await getCurrentUserReferenceKey(settings), settings);
        if (userWorn?.description) lines.push(`[{{user}} is currently wearing: ${userWorn.description}]`);
        // 1 = в чате, глубина 1 — перед последним сообщением, как Author's Note.
        context.setExtensionPrompt(OUTFIT_PROMPT_KEY, lines.join('\n'), 1, 1);
    } catch (error) {
        iigLog('WARN', 'Outfit injection failed:', error?.message || error);
    }
}

export function initOutfitInjection() {
    const context = SillyTavern.getContext();
    // Перед каждой генерацией — свежий текст (чат или персона могли смениться).
    for (const name of ['CHAT_CHANGED', 'GENERATION_STARTED', 'GENERATE_BEFORE_COMBINE_PROMPTS']) {
        const event = context.event_types?.[name];
        if (event) context.eventSource.on(event, () => updateOutfitInjection());
    }
    updateOutfitInjection();
}
