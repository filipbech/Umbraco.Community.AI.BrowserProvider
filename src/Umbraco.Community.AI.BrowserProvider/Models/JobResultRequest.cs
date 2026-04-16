namespace Umbraco.Community.AI.BrowserProvider.Models;

/// <summary>
/// Request body for posting job result.
/// </summary>
public class JobResultRequest
{
    /// <summary>
    /// The result text from browser AI processing.
    /// </summary>
    public string Result { get; set; } = string.Empty;
}
