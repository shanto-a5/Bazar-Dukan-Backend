/**
 * Success envelope for every Vanta response.
 *
 * The client validates each payload against `{ ok: true, data, meta }`
 * (frontend `src/api/api-client.ts`) and treats anything else as a failure, so
 * the shape is decided here — once — instead of by each controller.
 *
 * The constructor keeps the original positional signature
 * `(statusCode, data, message)` so the 26 existing call sites keep working
 * unchanged; the status line is still chosen by the caller with
 * `res.status(...).json(...)`, which is what the HTTP layer should own anyway.
 * The human message is preserved under `meta.message`.
 */
class ApiResponse {
    constructor(
        statusCode,
        data,
        message = "Success"
    ){
        this.ok    = true
        this.data   = data
        this.meta   = { message }
    }
}
export{ApiResponse}
