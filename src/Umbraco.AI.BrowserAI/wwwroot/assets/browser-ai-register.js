/**
 * Browser AI Job Processor
 *
 * Backoffice entry point that listens for Browser AI jobs via SignalR
 * and processes them using Chrome's Prompt API (LanguageModel).
 *
 * Uses Umbraco's existing SignalR server event hub for push notifications,
 * with a slow fallback poll for resilience.
 */

import { UMB_AUTH_CONTEXT } from '@umbraco-cms/backoffice/auth';
import { UMB_SERVER_CONTEXT } from '@umbraco-cms/backoffice/server';
import { HubConnectionBuilder } from '@umbraco-cms/backoffice/external/signalr';

const POLL_ENDPOINT = '/umbraco/api/browserai/jobs/next';
const RESULT_ENDPOINT = (id) => `/umbraco/api/browserai/jobs/${id}/result`;
const ERROR_ENDPOINT = (id) => `/umbraco/api/browserai/jobs/${id}/error`;
const FALLBACK_POLL_INTERVAL = 30000; // 30 seconds - slow fallback only
const MAX_PROMPT_LENGTH = 4000;

let isProcessing = false;
let modelReady = false;

export const onInit = (host) => {
    console.log('[BrowserAI] Initializing Browser AI job processor');

    initBrowserAI(host);
};

async function initBrowserAI(host) {
    const available = await checkAndReportAvailability();

    if (!available) {
        console.warn('[BrowserAI] Language Model not available - job processing disabled');
        return;
    }

    await waitForModelReady();

    // Connect to SignalR for push notifications
    connectSignalR(host);

    // Slow fallback poll in case SignalR connection drops
    console.log('[BrowserAI] Starting fallback poll (every ' + FALLBACK_POLL_INTERVAL / 1000 + 's)');
    setInterval(processNextJob, FALLBACK_POLL_INTERVAL);

    // Process any jobs already in the queue
    await processNextJob();
}

/**
 * Connect to Umbraco's SignalR server event hub and listen for BrowserAI job notifications.
 */
function connectSignalR(host) {
    host.consumeContext(UMB_AUTH_CONTEXT, (authContext) => {
        host.consumeContext(UMB_SERVER_CONTEXT, async (serverContext) => {
            const token = await authContext.getLatestToken();
            const serverUrl = serverContext.getServerUrl();

            if (!token || !serverUrl) {
                console.warn('[BrowserAI] Could not get auth token or server URL for SignalR');
                return;
            }

            const hubUrl = `${serverUrl}/umbraco/serverEventHub`;
            console.log('[BrowserAI] Connecting to SignalR hub:', hubUrl);

            const connection = new HubConnectionBuilder()
                .withUrl(hubUrl, {
                    accessTokenFactory: () => authContext.getLatestToken(),
                })
                .build();

            connection.on('notify', (event) => {
                if (event.eventSource === 'BrowserAI' && event.eventType === 'JobCreated') {
                    console.log('[BrowserAI] SignalR: new job notification received');
                    processNextJob();
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
async function waitForModelReady() {
    console.log('[BrowserAI] Waiting for model to be fully ready...');

    let attempts = 0;
    const maxAttempts = 60;

    while (attempts < maxAttempts) {
        try {
            const availability = await LanguageModel.availability();
            console.log('[BrowserAI] Model availability check:', availability);

            if (availability === 'available') {
                console.log('[BrowserAI] Model reports available, testing with simple prompt...');

                try {
                    const testSession = await LanguageModel.create();
                    console.log('[BrowserAI] Test session created');

                    const testResult = await testSession.prompt('Say "Hello" and nothing else.');
                    console.log('[BrowserAI] Test prompt succeeded! Result:', testResult);

                    modelReady = true;
                    updateStatusIndicator('active');
                    return;
                } catch (testErr) {
                    console.warn('[BrowserAI] Test prompt failed:', testErr.name, testErr.message);
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
async function processNextJob() {
    if (isProcessing) return;
    if (!modelReady) return;

    isProcessing = true;

    try {
        const response = await fetch(POLL_ENDPOINT, {
            credentials: 'include',
        });

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

        try {
            let promptText = job.prompt;
            if (promptText.length > MAX_PROMPT_LENGTH) {
                console.warn('[BrowserAI] Prompt too long, truncating from', promptText.length, 'to', MAX_PROMPT_LENGTH);
                promptText = promptText.substring(0, MAX_PROMPT_LENGTH) + '...';
            }

            let finalPrompt;
            if (job.operationType === 'summarize') {
                finalPrompt = `Please summarize the following text concisely:\n\n${promptText}`;
            } else if (job.operationType === 'translate') {
                finalPrompt = `Please translate the following text to English:\n\n${promptText}`;
            } else {
                finalPrompt = promptText;
            }

            console.log('[BrowserAI] Creating language model session...');
            const session = await LanguageModel.create();
            console.log('[BrowserAI] Sending prompt...');

            const result = await session.prompt(finalPrompt);

            console.log('[BrowserAI] Model inference took:', Math.round(performance.now() - startTime), 'ms');
            console.log('[BrowserAI] Result length:', result.length);

            await fetch(RESULT_ENDPOINT(job.id), {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ result }),
            });

            console.log('[BrowserAI] Job completed:', job.id);

            // Immediately check for more work
            isProcessing = false;
            await processNextJob();

        } catch (err) {
            console.error('[BrowserAI] Error processing job:', job.id, err.name, err.message);

            await fetch(ERROR_ENDPOINT(job.id), {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: `${err.name}: ${err.message}` }),
            });
        }
    } catch (e) {
        console.warn('[BrowserAI] Error in job processing loop:', e);
    } finally {
        isProcessing = false;
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
