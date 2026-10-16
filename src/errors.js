// One error shape for every endpoint:
//   {"error":{"code","message","retryable","request_id","fields"?}}
// `message` is always safe to show a customer; internals only go to logs.

export class ApiError extends Error {
  constructor(status, code, message, { retryable = false, fields, cause } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.fields = fields;
    this.cause = cause;
  }
}

export const badRequest = (code, message) => new ApiError(400, code, message);

export const validationError = (fe) =>
  new ApiError(422, "validation_failed", fe.message, { fields: [{ field: fe.field, message: fe.message }] });

/**
 * Maps stripe-node errors (and network failures) to customer-safe API errors.
 * Our bugs / config issues → generic 5xx. Transient issues → retryable.
 */
export function fromStripe(err) {
  const generic = { cause: err };
  switch (err?.type) {
    case "StripeConnectionError": // includes timeouts, after stripe-node's own retries
      return new ApiError(503, "payment_provider_unavailable",
        "We couldn't reach our payment provider. Please try again in a moment.", { ...generic, retryable: true });
    case "StripeAuthenticationError":
    case "StripePermissionError": // bad, revoked or under-scoped key — an ops problem
      return new ApiError(500, "payments_misconfigured",
        "Payments are temporarily unavailable. Our team has been notified.", generic);
    case "StripeRateLimitError":
      return new ApiError(429, "rate_limited",
        "We're handling a lot of requests right now. Please wait a few seconds and try again.", { ...generic, retryable: true });
    case "StripeIdempotencyError":
      return new ApiError(409, "duplicate_request",
        "This request conflicts with an earlier one. Please refresh and try again.", generic);
    case "StripeCardError":
      return new ApiError(402, "card_error", err.message, generic); // Stripe writes these for end users
    case "StripeInvalidRequestError":
      if (err.code === "resource_missing") {
        return new ApiError(404, "not_found", "We couldn't find that checkout session.", generic);
      }
      if (err.code === "amount_too_large" || err.code === "amount_too_small") {
        return new ApiError(422, "amount_out_of_range",
          "That amount can't be processed. Please choose a different amount.", generic);
      }
      return new ApiError(502, "payment_setup_failed", "We couldn't start the payment. Please try again later.", generic);
    case "StripeAPIError":
      return new ApiError(502, "payment_provider_error",
        "Our payment provider had a problem. Please try again.", { ...generic, retryable: true });
    default:
      return new ApiError(500, "internal_error", "Something went wrong on our side. Please try again later.", generic);
  }
}
