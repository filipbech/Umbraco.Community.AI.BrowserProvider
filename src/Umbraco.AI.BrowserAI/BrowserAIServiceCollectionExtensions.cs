using Community.Umbraco.AI.BrowserAI.Filters;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Community.Umbraco.AI.BrowserAI;

/// <summary>
/// Extension methods for registering Browser AI services.
/// </summary>
public static class BrowserAIServiceCollectionExtensions
{
    /// <summary>
    /// Adds Browser AI services to the service collection.
    /// </summary>
    /// <param name="services">The service collection.</param>
    /// <returns>The service collection for chaining.</returns>
    public static IServiceCollection AddBrowserAI(this IServiceCollection services)
    {
        services.AddSingleton<IBrowserAIJobStore, InMemoryBrowserAIJobStore>();
        services.AddHostedService<BrowserAIJobCleanupService>();
        services.AddScoped<BrowserAIEnabledFilter>();

        services.AddOptions<BrowserAIProviderSettings>()
            .BindConfiguration("Umbraco:AI:BrowserProvider");

        return services;
    }
}
