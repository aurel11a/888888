// Гардероб поверх библиотеки персонажей.
// Run: node --experimental-vm-modules --test tests/wardrobe.test.cjs
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');
const { test } = require('node:test');

async function loadExtension() {
    const prompts = {};
    const tavern = {
        extensionSettings: {},
        characters: [{ name: 'Nolan', avatar: 'nolan.png' }, { name: 'Sam', avatar: 'sam.png' }],
        characterId: 0,
        name2: 'Nolan',
        chatId: 'chat-a',
        getCurrentChatId() { return this.chatId; },
        saveSettingsDebounced() {},
        setExtensionPrompt(key, text) { prompts[key] = text; },
        eventSource: { on() {} },
        event_types: {},
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    };
    const fetched = [];
    const context = vm.createContext({
        console, URL, Blob, FormData, AbortController, setTimeout, clearTimeout, structuredClone, atob, btoa,
        SillyTavern: { getContext: () => tavern },
        toastr: { success() {}, error() {}, warning() {}, info() {} },
        fetch: async (url) => {
            fetched.push(String(url));
            return new Response(new Uint8Array([String(url).length]), { headers: { 'Content-Type': 'image/png' } });
        },
        FileReader: class {
            async readAsDataURL(blob) {
                this.result = `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`;
                this.onloadend();
            }
        },
    });
    const modules = new Map();
    function moduleFor(filename) {
        if (modules.has(filename)) return modules.get(filename);
        const module = filename.endsWith(`${path.sep}src${path.sep}i18n.js`)
            ? new vm.SyntheticModule(['t', 'translate'], function () {
                this.setExport('t', (parts, ...values) => String.raw({ raw: parts }, ...values));
                this.setExport('translate', (value) => value);
            }, { context, identifier: filename })
            : new vm.SourceTextModule(readFileSync(filename, 'utf8'), {
                context, identifier: filename,
                initializeImportMeta(meta) { meta.url = pathToFileURL(filename).href; },
            });
        modules.set(filename, module);
        return module;
    }
    const sourceDir = path.resolve(__dirname, '../src');
    const root = moduleFor(path.join(sourceDir, 'providers.js'));
    await root.link((specifier, parent) => moduleFor(path.resolve(path.dirname(parent.identifier), specifier)));
    await root.evaluate();
    const settingsModule = moduleFor(path.join(sourceDir, 'settings.js')).namespace;
    const settings = settingsModule.getSettings();
    Object.assign(settings, { userAvatarFile: 'me.png', useActiveUserPersonaAvatar: false, sendRefDescriptions: true });
    return {
        tavern, prompts, fetched, settings,
        wardrobe: moduleFor(path.join(sourceDir, 'wardrobe.js')).namespace,
        references: moduleFor(path.join(sourceDir, 'references.js')).namespace,
        settingsModule,
    };
}

const NOLAN = 'avatar:nolan.png';
const SAM = 'avatar:sam.png';
const ME = 'avatar:me.png';

test('worn outfit is per chat', async () => {
    const { wardrobe, tavern, settings } = await loadExtension();
    const hoodie = wardrobe.addOutfit('char', NOLAN, { name: 'Hoodie', description: 'grey hoodie', imagePath: '/user/images/x/hoodie.png' });
    const suit = wardrobe.addOutfit('char', NOLAN, { name: 'Suit', description: 'black suit', imagePath: '/user/images/x/suit.png' });
    wardrobe.setWornOutfit('char', NOLAN, hoodie.id);
    tavern.chatId = 'chat-b';
    assert.equal(wardrobe.getWornOutfit('char', NOLAN), null, 'в другом чате ничего не надето');
    wardrobe.setWornOutfit('char', NOLAN, suit.id);
    tavern.chatId = 'chat-a';
    assert.equal(wardrobe.getWornOutfit('char', NOLAN).name, 'Hoodie');
    tavern.chatId = 'chat-b';
    assert.equal(wardrobe.getWornOutfit('char', NOLAN).name, 'Suit');
    assert.equal(Object.keys(settings.wardrobeWorn).length, 2);
});

test('same picture is not added twice; removing unwears everywhere', async () => {
    const { wardrobe, tavern } = await loadExtension();
    const a = wardrobe.addOutfit('char', NOLAN, { name: 'A', imagePath: '/user/images/x/a.png' });
    const again = wardrobe.addOutfit('char', NOLAN, { name: 'A copy', imagePath: '/user/images/x/a.png' });
    assert.equal(a.id, again.id);
    assert.equal(wardrobe.getOutfits('char', NOLAN).length, 1);
    wardrobe.setWornOutfit('char', NOLAN, a.id);
    tavern.chatId = 'chat-b';
    wardrobe.setWornOutfit('char', NOLAN, a.id);
    wardrobe.removeOutfit('char', NOLAN, a.id);
    assert.equal(wardrobe.getWornOutfit('char', NOLAN), null);
    tavern.chatId = 'chat-a';
    assert.equal(wardrobe.getWornOutfit('char', NOLAN), null);
});

test('only the worn outfit is sent, right after the face', async () => {
    const { wardrobe, references, fetched } = await loadExtension();
    const hoodie = wardrobe.addOutfit('char', NOLAN, { name: 'Hoodie', description: 'grey hoodie', imagePath: '/user/images/x/hoodie.png' });
    wardrobe.addOutfit('char', NOLAN, { name: 'Suit', description: 'black suit', imagePath: '/user/images/x/suit.png' });

    let refs = await references.collectCharacterLibraryReferences('char', 'base64');
    assert.equal(refs.length, 1, 'ничего не надето — только лицо');
    assert.ok(!fetched.some(u => u.includes('hoodie') || u.includes('suit')));

    wardrobe.setWornOutfit('char', NOLAN, hoodie.id);
    refs = await references.collectCharacterLibraryReferences('char', 'base64');
    assert.equal(refs.length, 2);
    assert.equal(references.getReferenceSource(refs[1]), 'char');
    assert.match(references.getReferenceDescription(refs[1]), /outfit "Hoodie": grey hoodie/);
    assert.ok(fetched.includes('/user/images/x/hoodie.png'));
    assert.ok(!fetched.includes('/user/images/x/suit.png'), 'не надетый наряд не уходит');
});

test('outfits do not show up as library appearance details', async () => {
    const { wardrobe, references } = await loadExtension();
    wardrobe.addOutfit('char', NOLAN, { name: 'Hoodie', description: 'grey hoodie', imagePath: '/user/images/x/hoodie.png' });
    assert.equal(references.getCharacterLibraryDescription('char', NOLAN), '', 'описание наряда не попадает в описание персонажа');
});

test('favorites: like, then wear on another character with the same file', async () => {
    const { wardrobe, tavern } = await loadExtension();
    const dress = wardrobe.addOutfit('char', NOLAN, { name: 'Dress', description: 'red dress', imagePath: '/user/images/x/dress.png', category: 'formal' });
    assert.equal(wardrobe.toggleFavorite(dress), true);
    assert.equal(wardrobe.isFavorite(dress), true);
    const [fav] = wardrobe.getFavorites();
    assert.equal(fav.category, 'formal');

    tavern.characterId = 1; tavern.name2 = 'Sam';
    const worn = wardrobe.wearFavorite('char', SAM, fav);
    assert.equal(worn.imagePath, '/user/images/x/dress.png');
    assert.equal(wardrobe.getWornOutfit('char', SAM).id, worn.id);
    assert.equal(wardrobe.getOutfits('char', NOLAN).length, 1, 'у Нолана ничего не поменялось');

    assert.equal(wardrobe.toggleFavorite(dress), false);
    assert.equal(wardrobe.getFavorites().length, 0);
});

test('chat text says what is worn, for character and user', async () => {
    const { wardrobe, prompts } = await loadExtension();
    const hoodie = wardrobe.addOutfit('char', NOLAN, { name: 'Hoodie', description: 'grey hoodie', imagePath: '/user/images/x/h.png' });
    const coat = wardrobe.addOutfit('user', ME, { name: 'Coat', description: 'beige coat', imagePath: '/user/images/x/c.png' });
    wardrobe.setWornOutfit('char', NOLAN, hoodie.id);
    wardrobe.setWornOutfit('user', ME, coat.id);
    await wardrobe.updateOutfitInjection();
    assert.equal(prompts.chamber_outfits, '[Nolan is currently wearing: grey hoodie]\n[{{user}} is currently wearing: beige coat]');
    wardrobe.setWornOutfit('char', NOLAN, null);
    wardrobe.setWornOutfit('user', ME, null);
    await wardrobe.updateOutfitInjection();
    assert.equal(prompts.chamber_outfits, '');
});

test('style picture: kept on the style and sent only while the style is active', async () => {
    const { references, settingsModule, settings, fetched } = await loadExtension();
    settings.styles = [{ id: 's1', name: 'Watercolor', value: 'watercolor', imagePath: '/user/images/styles/w.jpg' }, { id: 's2', name: 'Plain', value: 'flat' }];
    settings.activeStyleId = 's1';
    settingsModule.ensureStyles(settings);
    assert.equal(settings.styles[0].imagePath, '/user/images/styles/w.jpg', 'картинка не теряется при нормализации');
    assert.equal('imagePath' in settings.styles[1], false);

    const ref = await references.collectStyleReference('base64', settings);
    assert.equal(references.getReferenceSource(ref), 'style');
    assert.match(references.getReferenceDescription(ref), /Art style reference/);
    assert.ok(fetched.includes('/user/images/styles/w.jpg'));

    settings.activeStyleId = 's2';
    assert.equal(await references.collectStyleReference('base64', settings), null);
    settings.activeStyleId = '';
    assert.equal(await references.collectStyleReference('base64', settings), null);

    settingsModule.updateStyle('s1', { imagePath: '' });
    assert.equal('imagePath' in settings.styles[0], false, '«Убрать» стирает поле');
});
