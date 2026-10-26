/**
 * Inline Image Generation — entry point.
 *
 * Catches `[IMG:GEN:{json}]` tags in AI messages and `<img data-iig-instruction>`
 * and generates images via configured API.
 *
 * Вся логика вынесена в `src/`. Этот файл — только импорт + init.
 */

import {
    getSettings,
    initializeConnectionProfiles,
    saveSettings,
} from './src/settings.js';
import { createSettingsUI } from './src/ui.js';
import { addButtonsToExistingMessages, subscribeEvents } from './src/events.js';
import { registerIigBookMacro } from './src/references.js';
import { resolveActiveProvider } from './src/providers.js';
import { initLightbox } from './src/lightbox.js';
import { initImageActions } from './src/imageActions.js';
import { initOutfitInjection } from './src/wardrobe.js';
import { initWardrobeUi } from './src/wardrobeUi.js';
import { runVishMigrationOnce } from './src/migration.js';

// sillyimages обрабатывает те же теги и использует те же id элементов настроек.
async function warnIfSillyimagesActive() {
    const disabled = SillyTavern.getContext().extensionSettings?.disabledExtensions || [];
    if (disabled.includes('third-party/sillyimages')) return;
    try {
        const response = await fetch('/scripts/extensions/third-party/sillyimages/manifest.json', { method: 'HEAD' });
        if (!response.ok) return;
    } catch (_error) {
        return;
    }
    toastr.warning('Включены и Chamber of Secrets, и sillyimages — картинки будут генерироваться дважды. Отключи sillyimages в Extensions.',
        'Chamber of Secrets', { timeOut: 0, extendedTimeOut: 0 });
}

(function init() {
    const context = SillyTavern.getContext();

    // Load/seed settings eagerly so getSettings() сразу возвращает валидный объект.
    const settings = getSettings();

    initializeConnectionProfiles(settings);
    saveSettings();

    // Register {{iig-book}} macro — делает refs-список доступным для вставки
    // в карточки / пресеты, чтобы LLM видела какие триггеры можно ставить.
    registerIigBookMacro(() => resolveActiveProvider()?.supportsReferences(getSettings()) === true);

    // Create settings UI when app is ready.
    context.eventSource.on(context.event_types.APP_READY, () => {
        warnIfSillyimagesActive();
        createSettingsUI();
        initOutfitInjection();
        // Кнопка гардероба у поля ввода; шторка создаётся только при открытии.
        initWardrobeUi();
        // Разовый перенос нарядов и НПС из старого vish (старые данные не трогаются).
        runVishMigrationOnce();
        // Add buttons to any messages already in chat.
        addButtonsToExistingMessages();
        // Lightbox: делегированный click-handler на #chat, оверлей один на страницу.
        initLightbox();
        // Floating corner-кнопки на сгенерированных картинках.
        initImageActions();
        console.log('[IIG] Inline Image Generation extension loaded');
    });

    subscribeEvents();

    console.log('[IIG] Inline Image Generation extension initialized');
})();
