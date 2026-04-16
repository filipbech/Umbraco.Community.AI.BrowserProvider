using Umbraco.AI.Core.EditableModels;

namespace Umbraco.Community.AI.BrowserProvider;

/// <summary>
/// Settings for the Browser AI provider.
/// </summary>
public class BrowserAIProviderSettings
{
    /// <summary>
    /// Whether the Browser AI provider is enabled.
    /// </summary>
    [AIField]
    public bool Enabled { get; set; } = true;

    /// <summary>
    /// Timeout in seconds for waiting for browser response.
    /// </summary>
    [AIField]
    public int TimeoutSeconds { get; set; } = 30;

    /// <summary>
    /// Maximum age in seconds for jobs before they are purged.
    /// </summary>
    [AIField]
    public int MaxJobAgeSeconds { get; set; } = 300;

    /// <summary>
    /// Maximum prompt length in characters before truncation.
    /// </summary>
    [AIField]
    public int MaxPromptLength { get; set; } = 4000;
}
