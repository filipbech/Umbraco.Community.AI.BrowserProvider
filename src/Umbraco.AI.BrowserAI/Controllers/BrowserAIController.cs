using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Community.Umbraco.AI.BrowserAI.Filters;
using Community.Umbraco.AI.BrowserAI.Models;
using Umbraco.Cms.Web.Common.Authorization;

namespace Community.Umbraco.AI.BrowserAI.Controllers;

/// <summary>
/// API controller for Browser AI job management.
/// </summary>
[ApiController]
[Route("umbraco/api/browserai")]
[ServiceFilter(typeof(BrowserAIEnabledFilter))]
public class BrowserAIController : ControllerBase
{
    private readonly IBrowserAIJobStore _jobStore;
    private readonly IOptions<BrowserAIProviderSettings> _settings;
    private readonly ILogger<BrowserAIController> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="BrowserAIController"/> class.
    /// </summary>
    public BrowserAIController(
        IBrowserAIJobStore jobStore,
        IOptions<BrowserAIProviderSettings> settings,
        ILogger<BrowserAIController> logger)
    {
        _jobStore = jobStore;
        _settings = settings;
        _logger = logger;
    }

    /// <summary>
    /// Health check endpoint - no auth required.
    /// </summary>
    [HttpGet("status")]
    [AllowAnonymous]
    public IActionResult GetStatus()
    {
        return Ok(new StatusResponse
        {
            Available = true,
            Version = "1.0",
            MaxPromptLength = _settings.Value.MaxPromptLength
        });
    }

    /// <summary>
    /// Gets the next pending job for processing.
    /// </summary>
    [HttpGet("jobs/next")]
    [Authorize(Policy = AuthorizationPolicies.BackOfficeAccess)]
    public async Task<IActionResult> GetNextJob()
    {
        var job = await _jobStore.GetNextPendingJobAsync();

        if (job is null)
        {
            return NoContent();
        }

        _logger.LogDebug("Job {JobId} picked up by browser", job.Id);

        return Ok(new JobResponse
        {
            Id = job.Id,
            Prompt = job.Prompt,
            SystemPrompt = job.SystemPrompt,
            OperationType = job.OperationType
        });
    }

    /// <summary>
    /// Posts the result of a completed job.
    /// </summary>
    [HttpPost("jobs/{id}/result")]
    [Authorize(Policy = AuthorizationPolicies.BackOfficeAccess)]
    public async Task<IActionResult> PostResult(string id, [FromBody] JobResultRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Result))
        {
            return BadRequest(new { error = "Result cannot be empty" });
        }

        var job = await _jobStore.GetJobAsync(id);
        if (job is null)
        {
            return NotFound(new { error = "Job not found" });
        }

        if (job.Status != BrowserAIJobStatus.Processing)
        {
            _logger.LogDebug("Ignoring result for job {JobId} in status {Status}", id, job.Status);
            return Conflict(new { error = $"Job is in status {job.Status}, expected Processing" });
        }

        await _jobStore.MarkCompleteAsync(id, request.Result);
        _logger.LogDebug("Job {JobId} completed successfully", id);

        return Ok();
    }

    /// <summary>
    /// Posts an error for a failed job.
    /// </summary>
    [HttpPost("jobs/{id}/error")]
    [Authorize(Policy = AuthorizationPolicies.BackOfficeAccess)]
    public async Task<IActionResult> PostError(string id, [FromBody] JobErrorRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Error))
        {
            return BadRequest(new { error = "Error message cannot be empty" });
        }

        var job = await _jobStore.GetJobAsync(id);
        if (job is null)
        {
            return NotFound(new { error = "Job not found" });
        }

        if (job.Status != BrowserAIJobStatus.Processing)
        {
            _logger.LogDebug("Ignoring error for job {JobId} in status {Status}", id, job.Status);
            return Conflict(new { error = $"Job is in status {job.Status}, expected Processing" });
        }

        await _jobStore.MarkFailedAsync(id, request.Error);
        _logger.LogWarning("Job {JobId} failed: {Error}", id, request.Error);

        return Ok();
    }
}
