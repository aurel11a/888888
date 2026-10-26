/**
 * Разовый перенос данных из старого vish (ветка main).
 *
 * - silly_wardrobe.wardrobes[имя].bot  → наряды персонажа с таким именем (base64 → файлы);
 * - silly_wardrobe.wardrobes[*].user   → наряды текущей персоны и Избранное (одинаковые картинки — один раз);
 * - общий гардероб (shared*Wardrobe, уже файлы) → Избранное;
 * - vish_image_gen.npcReferences       → лорбук «НПС из vish» (лицо и наряд — отдельные рефы).
 *
 * Старые ключи не трогаем: на main можно откатиться. Повторно не запускается (settings.vishMigration).
 */

import { getSettings, saveSettings, iigLog, ensureLorebooks, MAX_ADDITIONAL_REFERENCES } from './settings.js';
import { getCharacterReferenceKeyForCharacter, getCurrentUserReferenceKey } from './references.js';
import { saveImageToFile, normalizeStoredImagePath } from './utils.js';
import { addOutfit, toggleFavorite, isFavorite } from './wardrobe.js';

const MIGRATION_VERSION = 1;
const IMAGE_FOLDER = 'wardrobe';

function toDataUrl(base64) {
    const value = String(base64 || '').trim();
    if (!value) return '';
    return value.startsWith('data:') ? value : `data:image/jpeg;base64,${value}`;
}

function outfitData(o, imagePath) {
    return {
        name: o.name,
        description: o.description,
        imagePath,
        category: o.type,
        gender: o.gender,
        catalogId: o.catalogId,
    };
}

/** Перенести; возвращает счётчики. Ошибка одной картинки не останавливает остальные. */
export async function migrateFromVish({ force = false } = {}) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const stats = { charOutfits: 0, userOutfits: 0, favorites: 0, npcRefs: 0, skippedChars: [], failed: 0 };
    if (!force && settings.vishMigration?.version >= MIGRATION_VERSION) return null;

    const sw = context.extensionSettings?.silly_wardrobe;
    const iig = context.extensionSettings?.vish_image_gen;
    if (!sw && !iig?.npcReferences?.length) {
        settings.vishMigration = { version: MIGRATION_VERSION, at: Date.now(), nothing: true };
        saveSettings();
        return null;
    }

    // Одна и та же base64-картинка (часто у Юзера в разных чатах) сохраняется один раз.
    const savedByData = new Map();
    async function fileFor(o, label) {
        if (o?.imagePath) return normalizeStoredImagePath(o.imagePath);
        const dataUrl = toDataUrl(o?.base64);
        if (!dataUrl) return '';
        if (savedByData.has(dataUrl)) return savedByData.get(dataUrl);
        try {
            const path = normalizeStoredImagePath(await saveImageToFile(dataUrl, { mode: 'vish-migration', refName: label }, { folder: IMAGE_FOLDER }));
            savedByData.set(dataUrl, path);
            return path;
        } catch (error) {
            stats.failed++;
            iigLog('WARN', `vish migration: «${label}» не сохранилась:`, error?.message || error);
            return '';
        }
    }

    const characters = Array.isArray(context.characters) ? context.characters : [];
    const userKey = await getCurrentUserReferenceKey(settings);

    for (const [charName, wardrobe] of Object.entries(sw?.wardrobes || {})) {
        const bot = Array.isArray(wardrobe?.bot) ? wardrobe.bot : [];
        const user = Array.isArray(wardrobe?.user) ? wardrobe.user : [];
        if (bot.length) {
            const index = characters.findIndex(c => c?.name === charName);
            if (index < 0) {
                stats.skippedChars.push(charName);
            } else {
                const key = getCharacterReferenceKeyForCharacter(characters[index], index);
                for (const o of bot) {
                    const imagePath = await fileFor(o, `${charName} ${o.name || ''}`);
                    if (!imagePath) continue;
                    addOutfit('char', key, outfitData(o, imagePath), settings);
                    stats.charOutfits++;
                }
            }
        }
        for (const o of user) {
            const imagePath = await fileFor(o, `user ${o.name || ''}`);
            if (!imagePath) continue;
            const data = outfitData(o, imagePath);
            addOutfit('user', userKey, data, settings);
            // В старом vish наряды Юзера не были привязаны к персоне — пусть будут доступны любой.
            if (!isFavorite(data, settings)) toggleFavorite(data, settings);
            stats.userOutfits++;
        }
    }

    for (const o of [...(sw?.sharedBotWardrobe || []), ...(sw?.sharedUserWardrobe || [])]) {
        const imagePath = await fileFor(o, `shared ${o?.name || ''}`);
        if (!imagePath) continue;
        const data = outfitData(o, imagePath);
        if (!isFavorite(data, settings)) {
            toggleFavorite(data, settings);
            stats.favorites++;
        }
    }

    const npcs = (iig?.npcReferences || []).filter(n => n?.name);
    if (npcs.length) {
        const lorebooks = ensureLorebooks(settings);
        let book = lorebooks.find(lb => lb.name === 'НПС из vish');
        if (!book) {
            book = { id: `lb-vish-${Date.now().toString(36)}`, name: 'НПС из vish', enabled: true, refs: [], meta: { sourceUrl: '', importedAt: Date.now(), version: null } };
            lorebooks.push(book);
        }
        const has = new Set(book.refs.map(r => r.imagePath));
        const pushRef = (ref) => {
            if (!ref.imagePath || has.has(ref.imagePath) || book.refs.length >= MAX_ADDITIONAL_REFERENCES) return;
            has.add(ref.imagePath);
            book.refs.push({ id: `ref-vish-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, matchMode: 'match', enabled: true, group: '', priority: 0, useRegex: false, secondaryKeys: '', ...ref });
            stats.npcRefs++;
        };
        for (const npc of npcs) {
            const enabled = npc.enabled !== false;
            const face = npc.imagePath ? normalizeStoredImagePath(npc.imagePath) : await fileFor({ base64: npc.imageBase64 }, `npc ${npc.name}`);
            pushRef({ name: npc.name, description: String(npc.description || '').trim(), imagePath: face, enabled });
            if (npc.outfit?.imagePath || npc.outfit?.base64) {
                const outfit = await fileFor(npc.outfit, `npc ${npc.name} outfit`);
                const desc = String(npc.outfit.description || '').trim();
                pushRef({ name: npc.name, description: `outfit${npc.outfit.name ? ` "${npc.outfit.name}"` : ''}${desc ? `: ${desc}` : ''}`, imagePath: outfit, enabled });
            }
        }
        ensureLorebooks(settings);
    }

    settings.vishMigration = { version: MIGRATION_VERSION, at: Date.now(), ...stats };
    saveSettings();
    iigLog('INFO', 'vish migration done:', JSON.stringify(stats));
    return stats;
}

/** Запуск при старте: тихо, с одним тостом об итогах. */
export async function runVishMigrationOnce() {
    try {
        // Персона становится известна только к открытию чата; без неё наряды Юзера ушли бы на аватар по умолчанию.
        if (!(await getCurrentUserReferenceKey()).startsWith('avatar:') || !SillyTavern.getContext().getCurrentChatId?.()) {
            const context = SillyTavern.getContext();
            context.eventSource.once?.(context.event_types.CHAT_CHANGED, () => setTimeout(runVishMigrationOnce, 500));
            return;
        }
        const stats = await migrateFromVish();
        if (!stats) return;
        const parts = [];
        if (stats.charOutfits) parts.push(`нарядов персонажей: ${stats.charOutfits}`);
        if (stats.userOutfits) parts.push(`нарядов Юзера: ${stats.userOutfits}`);
        if (stats.favorites) parts.push(`в избранное: ${stats.favorites}`);
        if (stats.npcRefs) parts.push(`НПС-рефов: ${stats.npcRefs}`);
        if (!parts.length && !stats.failed) return;
        let text = `Перенесено из старого vish — ${parts.join(', ') || 'ничего'}.`;
        if (stats.skippedChars.length) text += ` Не нашлись персонажи: ${stats.skippedChars.join(', ')}.`;
        if (stats.failed) text += ` Не сохранилось картинок: ${stats.failed}.`;
        toastr.info(text, 'Chamber of Secrets', { timeOut: 12000 });
    } catch (error) {
        iigLog('ERROR', 'vish migration failed:', error?.message || error);
    }
}
