using System.Runtime.CompilerServices;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Logging;
using Community.Umbraco.AI.BrowserAI.Models;

namespace Community.Umbraco.AI.BrowserAI;

/// <summary>
/// Chat client that uses the browser-based job queue for AI processing.
/// </summary>
public class BrowserAIChatClient : IChatClient
{
    private readonly IBrowserAIJobStore _jobStore;
    private readonly ILogger _logger;
    private readonly BrowserAIProviderSettings _settings;
    private readonly string _operationType;

    private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(500);

    /// <summary>
    /// Initializes a new instance of the <see cref="BrowserAIChatClient"/> class.
    /// </summary>
    public BrowserAIChatClient(
        IBrowserAIJobStore jobStore,
        ILogger logger,
        BrowserAIProviderSettings settings,
        string operationType)
    {
        _jobStore = jobStore;
        _logger = logger;
        _settings = settings;
        _operationType = operationType;
    }

    /// <inheritdoc />
    public ChatClientMetadata Metadata => new("BrowserAI", new Uri("https://localhost"), "gemini-nano");

    /// <inheritdoc />
    public async Task<ChatResponse> GetResponseAsync(
        IEnumerable<ChatMessage> chatMessages,
        ChatOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        var messagesList = chatMessages.ToList();
        var (systemPrompt, prompt) = BuildPromptsFromMessages(messagesList);

        var result = await ProcessJobAsync(prompt, cancellationToken, systemPrompt);
        return new ChatResponse(new ChatMessage(ChatRole.Assistant, result));
    }

    /// <inheritdoc />
    public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
        IEnumerable<ChatMessage> chatMessages,
        ChatOptions? options = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var messagesList = chatMessages.ToList();
        var (systemPrompt, prompt) = BuildPromptsFromMessages(messagesList);

        var result = await ProcessJobAsync(prompt, cancellationToken, systemPrompt);

        // Browser AI doesn't support streaming, so we return the complete result as a single update
        yield return new ChatResponseUpdate(
            role: ChatRole.Assistant,
            content: result);
    }

    /// <inheritdoc />
    public object? GetService(Type serviceType, object? serviceKey = null)
        => serviceType == typeof(IChatClient) ? this : null;

    /// <inheritdoc />
    public void Dispose()
    {
    }

    private static (string? systemPrompt, string prompt) BuildPromptsFromMessages(IList<ChatMessage> chatMessages)
    {
        var systemMessages = chatMessages
            .Where(m => m.Role == ChatRole.System)
            .ToList();

        var nonSystemMessages = chatMessages
            .Where(m => m.Role != ChatRole.System)
            .ToList();

        string? systemPrompt = systemMessages.Count > 0
            ? string.Join("\n", systemMessages.Select(m => m.Text))
            : null;

        string prompt;
        if (nonSystemMessages.Count == 1)
        {
            prompt = nonSystemMessages[0].Text ?? string.Empty;
        }
        else if (nonSystemMessages.Count > 1)
        {
            prompt = string.Join("\n\n", nonSystemMessages.Select(m => $"{m.Role}: {m.Text}"));
        }
        else
        {
            prompt = string.Empty;
        }

        return (systemPrompt, prompt);
    }

    private async Task<string> ProcessJobAsync(string prompt, CancellationToken cancellationToken, string? systemPrompt = null)
    {
        if (prompt.Length > _settings.MaxPromptLength)
        {
            _logger.LogWarning("Prompt exceeds max length ({Length} > {Max}), truncating", prompt.Length, _settings.MaxPromptLength);
            prompt = prompt[.._settings.MaxPromptLength];
        }

        var job = await _jobStore.CreateJobAsync(prompt, _operationType, systemPrompt);
        _logger.LogDebug("Browser AI job {JobId} created with operation type {OperationType}", job.Id, _operationType);

        var timeout = TimeSpan.FromSeconds(_settings.TimeoutSeconds);
        var deadline = DateTimeOffset.UtcNow.Add(timeout);

        while (DateTimeOffset.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();

            await Task.Delay(PollInterval, cancellationToken);
            var updated = await _jobStore.GetJobAsync(job.Id);

            if (updated?.Status == BrowserAIJobStatus.Complete)
            {
                _logger.LogDebug("Browser AI job {JobId} completed successfully", job.Id);
                return updated.Result ?? string.Empty;
            }

            if (updated?.Status == BrowserAIJobStatus.Failed)
            {
                _logger.LogWarning("Browser AI job {JobId} failed: {Error}", job.Id, updated.Error);
                throw new InvalidOperationException(updated.Error ?? "Browser AI failed");
            }
        }

        // Timeout reached — mark failed so browser knows to discard any late result
        await _jobStore.MarkFailedAsync(job.Id, "Timed out waiting for browser");
        _logger.LogWarning("Browser AI job {JobId} timed out after {Timeout} seconds", job.Id, _settings.TimeoutSeconds);

        throw new TimeoutException("Browser AI timed out. Is the backoffice open in a browser with Gemini Nano support?");
    }
}
