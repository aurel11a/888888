// Run: node --test tests/image-routers.cjs (no API calls or credentials).
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const source = readFileSync(require('node:path').join(__dirname, '../src/providers.js'), 'utf8');
const routerSource = source.slice(source.indexOf('export class GeminiImageRouterProvider'), source.indexOf('\nconst providers = new Map();')).replace('export class', 'class');

function setup(id, responses, overrides = {}) {
    const settings = { apiType: id, endpoint: `https://api.${id}.test/v1`, apiKey: 'test-key', model: id === 'altrouter' ? 'nano-banana-pro' : 'google/gemini-3-pro-image', imageSize: '2K', aspectRatio: '16:9', ...overrides };
    const calls = [];
    const context = {
        Provider: class {},
        ProviderError: class extends Error { constructor(values) { super(values.message); Object.assign(this, values); } },
        getSettings: () => settings,
        getEffectiveEndpoint: s => s.endpoint,
        getGeminiCapabilities: () => ({ aspectRatios: ['1:1', '16:9'], imageSizes: ['1K', '2K', '4K'] }),
        getReferenceImage: ref => ref.image,
        getReferenceDescription: ref => ref.description || '',
        referenceTextLabel: (i, description) => description ? `Reference ${i}: ${description}` : '',
        appendPromptBlock: (prompt, block) => block ? `${prompt}\n\n${block}` : prompt,
        buildFinalGenerationPrompt: prompt => prompt,
        getEffectiveRefInstruction: () => 'Use the references.',
        extractImageFromResult: result => result.data[0].url || `data:image/png;base64,${result.data[0].b64_json}`,
        parseOpenAIError: async response => ({ status: response.status, message: 'API error', code: 'api_error' }),
        GEMINI_REQUEST_TIMEOUT_MS: 600000,
        iigLog: () => {}, Date, URL, TextEncoder, btoa, crypto: require('node:crypto').webcrypto,
        t: strings => strings.join(''),
        abortableDelay: async (_ms, signal) => { if (signal?.aborted) throw new Error('aborted'); },
        fetchWithTimeout: async (url, init, _timeout, signal) => {
            if (signal?.aborted) throw new Error('aborted');
            calls.push({ url, ...init });
            if (id === 'closerouter' && url.endsWith('/media/models')) {
                const lite = settings.model.includes('lite-image');
                const operation = { name: 'generate', input_image_fields: [lite ? 'image_urls' : 'image_input'], input_schema: {
                    required: ['prompt'], properties: { prompt: { type: 'string' }, aspect_ratio: { enum: ['1:1', '16:9'] },
                        [lite ? 'image_urls' : 'image_input']: { type: 'array', maxItems: lite ? 10 : 8 },
                        ...(lite ? {} : { resolution: { enum: ['1K', '2K', '4K'] } }),
                    },
                } };
                return { ok: true, status: 200, json: async () => ({ data: [
                    { model: settings.model, endpoint: '/v1/images/generations', provider_option_id: 'generation-route', operations: [operation] },
                    ...(lite ? [] : [{ model: settings.model, endpoint: '/v1/images/edits', provider_option_id: 'edit-route', operations: [operation] }]),
                ] }) };
            }
            if (id === 'closerouter' && url.endsWith('/media/quote')) return { ok: true, status: 200, json: async () => ({ reserved_usd: '0.04500000' }) };
            const next = responses.shift();
            if (next instanceof Error) throw next;
            assert.ok(next, 'Unexpected extra API call');
            return { ok: next.status < 400, status: next.status, json: async () => next.body, blob: async () => ({ arrayBuffer: async () => next.bytes }) };
        },
    };
    vm.createContext(context);
    const provider = vm.runInContext(`${routerSource}\nnew GeminiImageRouterProvider('${id}', '${id}')`, context);
    return { provider, calls, settings };
}
const image = { status: 200, body: { data: [{ b64_json: 'aGVsbG8=' }] } };

for (const id of ['altrouter', 'closerouter']) {
    test(`${id}: references, resolution, async polling use one POST`, async () => {
        const object = id === 'altrouter' ? 'image.generation' : 'image.request';
        const { provider, calls } = setup(id, [
            { status: 202, body: { object, id: 'job/1', status: 'queued' } },
            { status: 200, body: { object, id: 'job/1', status: 'processing' } }, image,
        ]);
        assert.equal(await provider.generate({ prompt: 'A fox', references: [{ image: 'data:image/jpeg;base64,eA==', description: 'Face' }] }), 'data:image/png;base64,aGVsbG8=');
        const generationCalls = calls.filter(c => !/\/media\/(models|quote)$/.test(c.url));
        assert.equal(generationCalls.filter(c => c.method === 'POST').length, 1);
        const body = JSON.parse(generationCalls[0].body);
        assert.match(body.prompt || body.input.prompt, /Reference 1: Face/);
        assert.match(body.prompt || body.input.prompt, /Use the references/);
        assert.equal(body.model, id === 'altrouter' ? 'nano-banana-pro' : 'google/gemini-3-pro-image');
        assert.equal((body.image || body.input.image_input)[0], 'data:image/jpeg;base64,eA==');
        assert.equal(body.resolution || body.input.resolution, '2K');
        assert.match(generationCalls[0].url, id === 'altrouter' ? /\/images\/generations$/ : /\/images\/edits$/);
        assert.match(generationCalls[1].url, id === 'altrouter' ? /\/images\/generations\/job%2F1$/ : /\/media\/requests\/job%2F1$/);
    });
    test(`${id}: network failures cannot trigger pipeline retries`, async () => {
        const { provider, calls } = setup(id, [new Error('network timeout')]);
        await assert.rejects(provider.generate({ prompt: 'A fox' }), error => error.retryable === false);
        assert.equal(calls.filter(c => !/\/media\/(models|quote)$/.test(c.url)).length, 1);
    });
    test(`${id}: aborted requests do not submit`, async () => {
        const { provider, calls } = setup(id, []);
        await assert.rejects(provider.generate({ prompt: 'A fox', options: { signal: AbortSignal.abort() } }), error => error.code === 'aborted' && !error.retryable);
        assert.equal(calls.length, 0);
    });
}
test('CloseRouter: ordinary generation and unknown outcome', async () => {
    const { provider, calls } = setup('closerouter', [image]);
    await provider.generate({ prompt: 'A fox' });
    assert.match(calls.at(-1).url, /\/images\/generations$/);
    assert.equal(JSON.parse(calls.at(-1).body).input.image_input, undefined);
    const pending = setup('closerouter', [{ status: 202, body: { object: 'image.request', id: '1', status: 'outcome_unknown' } }]);
    await assert.rejects(pending.provider.generate({ prompt: 'A fox' }), error => error.code === 'outcome_unknown' && !error.retryable);
    assert.equal(pending.calls.filter(c => !/\/media\/(models|quote)$/.test(c.url)).length, 1);
});
test('Catalog filters text and other image model families', async () => {
    const { provider } = setup('altrouter', [{ status: 200, body: { data: ['google/gemini-3-pro-image', 'google/gemini-2.5-pro', 'openai/gpt-image-1', 'nano-banana-2'].map(id => ({ id })) } }]);
    assert.deepEqual(Array.from(await provider.fetchModels()), ['google/gemini-3-pro-image', 'nano-banana-2']);
});
test('AltRouter sends resolution for non-Pro models and honours catalog options', async () => {
    const plain = setup('altrouter', [image], { model: 'nano-banana', imageSize: '2K' });
    await plain.provider.generate({ prompt: 'Fox' });
    assert.equal(JSON.parse(plain.calls[0].body).resolution, '2K');

    const cat = setup('altrouter', [{ status: 200, body: { data: [
        { id: 'nano-banana-2', params: [{ key: 'resolution', type: 'enum', options: ['1K', '4K'] }] },
    ] } }, image], { model: 'nano-banana-2', imageSize: '4K' });
    await cat.provider.fetchModels();
    assert.deepEqual(Array.from(cat.provider.getImageResolutions(cat.settings)), ['1K', '4K']);
    await cat.provider.generate({ prompt: 'Fox' });
    assert.equal(JSON.parse(cat.calls.at(-1).body).resolution, '4K');
    cat.settings.imageSize = '2K';
    await assert.rejects(cat.provider.generate({ prompt: 'Fox' }), /Supported: 1K, 4K/);
});
test('CloseRouter resolutions come from the catalog and are not locked without it', async () => {
    const { provider, settings } = setup('closerouter', [], { model: 'google/gemini-3.1-flash-lite-image' });
    assert.deepEqual(Array.from(provider.getImageResolutions(settings)), ['1K', '2K', '4K']);
    await provider.loadMediaCatalog(settings);
    // The mocked Lite route exposes no resolution control, so nothing is claimed from the catalog.
    assert.deepEqual(Array.from(provider.getImageResolutions(settings)), ['1K', '2K', '4K']);
    const pro = setup('closerouter', [], { model: 'google/gemini-3-pro-image' });
    await pro.provider.loadMediaCatalog(pro.settings);
    assert.deepEqual(Array.from(pro.provider.getImageResolutions(pro.settings)), ['1K', '2K', '4K']);
});
test('AltRouter validates Pro resolution before sending', async () => {
    const { provider, calls } = setup('altrouter', [], { imageSize: '1K' });
    await assert.rejects(provider.generate({ prompt: 'A fox' }), /Supported: 2K, 4K/);
    assert.equal(calls.length, 0);
});

// Regression: Flash Lite accepts references on generations, with image_urls.
test('CloseRouter Lite uses catalog route, source field and reservation', async () => {
    const { provider, calls } = setup('closerouter', [image], { model: 'google/gemini-3.1-flash-lite-image', imageSize: '1K' });
    const refs = Array.from({ length: 3 }, () => ({ image: 'data:image/png;base64,eA==' }));
    await provider.generate({ prompt: 'A fox', references: refs });
    const request = calls.at(-1);
    const body = JSON.parse(request.body);
    assert.match(request.url, /\/images\/generations$/);
    assert.equal(body.input.image_urls.length, 3);
    assert.equal(body.input.resolution, undefined);
    assert.equal(body.max_cost_usd, '0.04500000');
    assert.equal(body.provider.option_id, 'generation-route');
});
test('CloseRouter rejects excess refs without generation or quote', async () => {
    const { provider, calls } = setup('closerouter', []);
    await assert.rejects(provider.generate({ prompt: 'Fox', references: Array(9).fill({ image: 'data:image/png;base64,eA==' }) }), /no route supports/);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /media\/models$/);
});
test('AltRouter uses local proxy for catalog and generation', async () => {
    const { provider, calls } = setup('altrouter', [{ status: 200, body: { data: [{ id: 'nano-banana' }] } }, image]);
    await provider.fetchModels();
    await provider.generate({ prompt: 'Fox' });
    assert.ok(calls.every(call => call.url.startsWith('/proxy/https://api.altrouter.test/v1/')));
});

test('AltRouter downloads a CDN URL result through the local proxy as a data URL', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 1, 2, 3]).buffer;
    const { provider, calls } = setup('altrouter', [
        { status: 200, body: { data: [{ url: 'https://cdn.altrouter.test/img/1.png' }] } },
        { status: 200, bytes: png },
    ]);
    const result = await provider.generate({ prompt: 'Fox' });
    assert.equal(result, `data:image/png;base64,${Buffer.from(png).toString('base64')}`);
    assert.equal(calls[1].url, '/proxy/https://cdn.altrouter.test/img/1.png');
    assert.equal(calls[1].headers, undefined, 'API key must not be sent to the CDN');
});
test('AltRouter falls back to the remote URL when the CDN download fails', async () => {
    const url = 'https://cdn.altrouter.test/x';
    const { provider } = setup('altrouter', [
        { status: 200, body: { data: [{ url }] } },
        { status: 403 }, { status: 403 },
    ]);
    assert.equal(await provider.generate({ prompt: 'Fox' }), url);
});
test('AltRouter falls back to direct fetch when the proxy download fails', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 9]).buffer;
    const { provider, calls } = setup('altrouter', [
        { status: 200, body: { data: [{ url: 'https://cdn.altrouter.test/y.png' }] } },
        { status: 404 }, { status: 200, bytes: png },
    ]);
    assert.match(await provider.generate({ prompt: 'Fox' }), /^data:image\/png;base64,/);
    assert.equal(calls[2].url, 'https://cdn.altrouter.test/y.png');
});

test('AltRouter retries a catalog timeout without making a generation', async () => {
    const timeout = Object.assign(new Error('Timeout'), { name: 'AbortError' });
    const { provider, calls } = setup('altrouter', [timeout, { status: 200, body: { data: [{ id: 'nano-banana-2-lite' }] } }]);
    assert.deepEqual(Array.from(await provider.fetchModels()), ['nano-banana-2-lite']);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.url.endsWith('/models') && !call.method));
});

test('AltRouter stops after two catalog timeouts', async () => {
    const timeout = () => Object.assign(new Error('Timeout'), { name: 'AbortError' });
    const { provider, calls } = setup('altrouter', [timeout(), timeout()]);
    await assert.rejects(provider.fetchModels(), /after two attempts/);
    assert.equal(calls.length, 2);
});

test('AltRouter does not retry a rejected API key', async () => {
    const { provider, calls } = setup('altrouter', [{ status: 401 }]);
    await assert.rejects(provider.fetchModels(), /401/);
    assert.equal(calls.length, 1);
});

test('Router normalizes a pasted catalog URL for model loading and generation', async () => {
    for (const suffix of ['', '/v1', '/v1/', '/v1/models', '/v1/models/', '/v1/images/generations', '/v1/media/models']) {
        const { provider, calls } = setup('altrouter', [
            { status: 200, body: { data: [{ id: 'nano-banana-2' }] } }, image,
        ], { endpoint: `https://api.altrouter.test${suffix}` });
        await provider.fetchModels();
        await provider.generate({ prompt: 'Fox', references: [{ image: 'data:image/png;base64,eA==' }] });
        assert.equal(calls[0].url, '/proxy/https://api.altrouter.test/v1/models');
        assert.equal(calls[1].url, '/proxy/https://api.altrouter.test/v1/images/generations');
    }
});

test('Explicit raw generation endpoint remains unchanged', async () => {
    const { provider, calls } = setup('altrouter', [image], {
        endpoint: 'https://api.altrouter.test/v1/images/generations', rawEndpoint: true,
    });
    await provider.generate({ prompt: 'Fox' });
    assert.equal(calls[0].url, '/proxy/https://api.altrouter.test/v1/images/generations');
});
