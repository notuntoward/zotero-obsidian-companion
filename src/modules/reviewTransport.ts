export class UncertainReviewError extends Error {}

export function requireCertainResponse(response: any): void {
  if (response?.connectionError || response?.outcomeUnknown)
    throw new UncertainReviewError(
      response.error || "The Obsidian request outcome is unknown.",
    );
}
