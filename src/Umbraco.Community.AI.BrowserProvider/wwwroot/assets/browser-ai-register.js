/**
 * Browser AI Job Processor
 *
 * Backoffice entry point that listens for Browser AI jobs via SignalR
 * and processes them using Chrome's Prompt API (LanguageModel).
 *
 * Uses Umbraco's existing SignalR server event hub for push notifications,
 * with a fallback poll for resilience.
 */

import { UMB_AUTH_CONTEXT } from '@umbraco-cms/backoffice/auth';
import { UMB_SERVER_CONTEXT } from '@umbraco-cms/backoffice/server';
import { HubConnectionBuilder } from '@umbraco-cms/backoffice/external/signalr';

const POLL_ENDPOINT = '/umbraco/api/browserai/jobs/next';
const RESULT_ENDPOINT = (id) => `/umbraco/api/browserai/jobs/${id}/result`;
const ERROR_ENDPOINT = (id) => `/umbraco/api/browserai/jobs/${id}/error`;
const STATUS_ENDPOINT = '/umbraco/api/browserai/status';
const FALLBACK_POLL_INTERVAL = 10000; // 10 seconds — must be shorter than server timeout

const OPERATION_SUMMARIZE = 'summarize';
const OPERATION_TRANSLATE = 'translate';

const SIGNALR_EVENT_SOURCE = 'BrowserAI';
const SIGNALR_EVENT_TYPE_JOB_CREATED = 'JobCreated';

export const onInit = (host) => {
    console.log('[BrowserAI] Initializing Browser AI job processor');

    const state = {
        isProcessing: false,
        modelReady: false,
        maxPromptLength: 4000,
        authContext: null,
    };

    host.consumeContext(UMB_AUTH_CONTEXT, (ctx) => {
        state.authContext = ctx;
        initBrowserAI(host, state);
    });
};

async function authFetch(state, url, options = {}) {
    if (state.authContext) {
        const token = await state.authContext.getLatestToken();
        options.headers = {
            ...options.headers,
            'Authorization': `Bearer ${token}`,
        };
    }
    return fetch(url, options);
}

async function initBrowserAI(host, state) {
    const available = await checkAndReportAvailability();

    if (!available) {
        console.warn('[BrowserAI] Language Model not available - job processing disabled');
        return;
    }

    // Fetch server configuration
    try {
        const statusResponse = await authFetch(state, STATUS_ENDPOINT);
        if (statusResponse.ok) {
            const status = await statusResponse.json();
            if (status.maxPromptLength) {
                state.maxPromptLength = status.maxPromptLength;
                console.log('[BrowserAI] Max prompt length configured to:', state.maxPromptLength);
            }
        }
    } catch (e) {
        console.warn('[BrowserAI] Could not fetch server config, using defaults');
    }

    await waitForModelReady(state);

    // Connect to SignalR for push notifications
    connectSignalR(host, state);

    // Fallback poll in case SignalR connection drops
    console.log('[BrowserAI] Starting fallback poll (every ' + FALLBACK_POLL_INTERVAL / 1000 + 's)');
    setInterval(() => processNextJob(state), FALLBACK_POLL_INTERVAL);

    // Process any jobs already in the queue
    await processNextJob(state);
}

/**
 * Connect to Umbraco's SignalR server event hub and listen for BrowserAI job notifications.
 */
function connectSignalR(host, state) {
    host.consumeContext(UMB_AUTH_CONTEXT, (authCtx) => {
        host.consumeContext(UMB_SERVER_CONTEXT, async (serverContext) => {
            const token = await authCtx.getLatestToken();
            const serverUrl = serverContext.getServerUrl();

            if (!token || !serverUrl) {
                console.warn('[BrowserAI] Could not get auth token or server URL for SignalR');
                return;
            }

            const hubUrl = `${serverUrl}/umbraco/serverEventHub`;
            console.log('[BrowserAI] Connecting to SignalR hub:', hubUrl);

            const connection = new HubConnectionBuilder()
                .withUrl(hubUrl, {
                    accessTokenFactory: () => authCtx.getLatestToken(),
                })
                .build();

            connection.on('notify', (event) => {
                if (event.eventSource === SIGNALR_EVENT_SOURCE && event.eventType === SIGNALR_EVENT_TYPE_JOB_CREATED) {
                    console.log('[BrowserAI] SignalR: new job notification received');
                    processNextJob(state);
                }
            });

            connection.onclose(() => {
                console.warn('[BrowserAI] SignalR connection closed, relying on fallback poll');
                updateStatusIndicator('disconnected');
            });

            try {
                await connection.start();
                console.log('[BrowserAI] SignalR connected - listening for job notifications');
            } catch (err) {
                console.warn('[BrowserAI] SignalR connection failed, relying on fallback poll:', err.message);
            }
        });
    });
}

/**
 * Wait for the model to be fully ready and verify it works with a test prompt.
 */
async function waitForModelReady(state) {
    console.log('[BrowserAI] Waiting for model to be fully ready...');

    let attempts = 0;
    const maxAttempts = 60;

    while (attempts < maxAttempts) {
        try {
            const availability = await LanguageModel.availability();
            console.log('[BrowserAI] Model availability check:', availability);

            if (availability === 'available') {
                console.log('[BrowserAI] Model reports available, testing with simple prompt...');
                let testSession;

                try {
                    testSession = await LanguageModel.create();
                    console.log('[BrowserAI] Test session created');

                    const testResult = await testSession.prompt('Say "Hello" and nothing else.');
                    console.log('[BrowserAI] Test prompt succeeded! Result:', testResult);

                    state.modelReady = true;
                    updateStatusIndicator('active');
                    return;
                } catch (testErr) {
                    console.warn('[BrowserAI] Test prompt failed:', testErr.name, testErr.message);
                } finally {
                    testSession?.destroy?.();
                }
            }

            if (availability === 'downloading') {
                updateStatusIndicator('downloading');
            }
        } catch (e) {
            console.warn('[BrowserAI] Error checking availability:', e);
        }

        attempts++;
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.warn('[BrowserAI] Model did not become ready after', maxAttempts, 'seconds');
    updateStatusIndicator('unavailable');
}

/**
 * Process the next pending job from the queue.
 */
async function processNextJob(state) {
    if (state.isProcessing) return;
    if (!state.modelReady) return;

    state.isProcessing = true;

    try {
        // Loop to process consecutive jobs without recursion
        while (true) {
            const response = await authFetch(state, POLL_ENDPOINT);

            if (response.status === 204) {
                return;
            }

            if (!response.ok) {
                console.warn('[BrowserAI] Error response from server:', response.status);
                return;
            }

            const job = await response.json();
            console.log('[BrowserAI] Processing job:', job.id, job.operationType);
            console.log('[BrowserAI] Prompt length:', job.prompt.length, 'chars');
            const startTime = performance.now();

            let session;
            try {
                let finalPrompt;
                if (job.operationType === OPERATION_SUMMARIZE) {
                    finalPrompt = `Please summarize the following text concisely:\n\n${job.prompt}`;
                } else if (job.operationType === OPERATION_TRANSLATE) {
                    finalPrompt = `Please translate the following text to English:\n\n${job.prompt}`;
                } else {
                    finalPrompt = job.prompt;
                }

                const sessionOptions = {};
                if (job.systemPrompt) {
                    sessionOptions.systemPrompt = job.systemPrompt;
                    console.log('[BrowserAI] Using system prompt (' + job.systemPrompt.length + ' chars)');
                }

                console.log('[BrowserAI] Creating language model session...');
                session = await LanguageModel.create(sessionOptions);
                console.log('[BrowserAI] Sending prompt...');

                const result = await session.prompt(finalPrompt);

                console.log('[BrowserAI] Model inference took:', Math.round(performance.now() - startTime), 'ms');
                console.log('[BrowserAI] Result length:', result.length);

                await authFetch(state, RESULT_ENDPOINT(job.id), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ result }),
                });

                console.log('[BrowserAI] Job completed:', job.id);

            } catch (err) {
                console.error('[BrowserAI] Error processing job:', job.id, err.name, err.message);

                await authFetch(state, ERROR_ENDPOINT(job.id), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: `${err.name}: ${err.message}` }),
                });
            } finally {
                session?.destroy?.();
            }
        }
    } catch (e) {
        console.warn('[BrowserAI] Error in job processing loop:', e);
    } finally {
        state.isProcessing = false;
    }
}

/**
 * Check browser AI availability and log status.
 * @returns {Promise<boolean>} True if Language Model API exists.
 */
async function checkAndReportAvailability() {
    if (typeof LanguageModel !== 'undefined') {
        try {
            const availability = await LanguageModel.availability();
            console.log('[BrowserAI] LanguageModel API found, initial availability:', availability);

            if (availability === 'available' || availability === 'downloadable' || availability === 'downloading') {
                return true;
            } else {
                console.warn('[BrowserAI] LanguageModel reports:', availability);
                console.info('[BrowserAI] To enable Gemini Nano, follow these steps:');
                console.info('[BrowserAI] 1. Go to: chrome://flags/#optimization-guide-on-device-model');
                console.info('[BrowserAI]    Set to "Enabled BypassPerfRequirement"');
                console.info('[BrowserAI] 2. Go to: chrome://flags/#prompt-api-for-gemini-nano');
                console.info('[BrowserAI]    Set to "Enabled"');
                console.info('[BrowserAI] 3. Restart Chrome');
                console.info('[BrowserAI] 4. Go to: chrome://components');
                console.info('[BrowserAI]    Find "Optimization Guide On Device Model"');
                console.info('[BrowserAI]    Click "Check for update" to download the model');
            }
        } catch (e) {
            console.warn('[BrowserAI] Error checking LanguageModel availability:', e);
        }
    } else {
        console.warn('[BrowserAI] LanguageModel API not found');
        console.info('[BrowserAI] Enable at: chrome://flags/#prompt-api-for-gemini-nano');
    }

    updateStatusIndicator('unavailable');
    return false;
}

/**
 * Update status indicator if it exists in the DOM.
 */
function updateStatusIndicator(status) {
    window.dispatchEvent(new CustomEvent('browser-ai-status', {
        detail: { status }
    }));
}
