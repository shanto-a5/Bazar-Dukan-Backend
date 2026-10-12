/**
 * Error type thrown by controllers and middleware.
 *
 * `code` is a Vanta-specific extension: the client branches on a stable,
 * machine-readable `error.code` (`validation_failed`, `unauthorized`,
 * `not_found`, …) rather than on prose, so a caller can say which rule failed
 * without the message becoming an API. It is optional — every existing
 * `new ApiError(status, message)` call site keeps working and falls back to the
 * status-derived code in the error handler.
 *
 * `errors` carries field-level problems; the error handler forwards entries
 * shaped `{ field, message }` as `error.fields`.
 */
class ApiError extends Error{
    constructor(
        statusCode,
        message = "Something went wrong!",
        errors  = [],
        stack   = "",
        code    = ""
    ){
        super(message)
        this.statusCode = statusCode
        this.message    = message
        this.errors     = errors
        this.code       = code
        this.data       = null
        this.success    = false
        if(stack){
        this.stack      = stack

        }else{
            Error.captureStackTrace(this, this.constructor)
        }
    }
}
export{ApiError}
