using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Extensions.Options;

namespace Community.Umbraco.AI.BrowserAI.Filters;

/// <summary>
/// Action filter that returns 503 when the Browser AI provider is disabled.
/// </summary>
public class BrowserAIEnabledFilter : IActionFilter
{
    private readonly IOptions<BrowserAIProviderSettings> _settings;

    /// <summary>
    /// Initializes a new instance of the <see cref="BrowserAIEnabledFilter"/> class.
    /// </summary>
    public BrowserAIEnabledFilter(IOptions<BrowserAIProviderSettings> settings)
    {
        _settings = settings;
    }

    /// <inheritdoc />
    public void OnActionExecuting(ActionExecutingContext context)
    {
        if (!_settings.Value.Enabled)
        {
            context.Result = new ObjectResult(new { error = "Browser AI provider is disabled" })
            {
                StatusCode = 503
            };
        }
    }

    /// <inheritdoc />
    public void OnActionExecuted(ActionExecutedContext context)
    {
    }
}
