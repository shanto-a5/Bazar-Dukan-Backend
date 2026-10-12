// must be the first import: app.js reads process.env (CORS_ORIGIN) at module
// load time, and ES module imports run in declaration order before this body
import "dotenv/config";
import { ConnectDB, DisconnectDB } from "./db/index.js";
import { app } from "./app.js";
import { assertMailConfig } from "./services/mailer.js";

// a misconfigured mail provider is a boot error, not a surprise halfway
// through somebody's password reset
try {
    assertMailConfig()
} catch (error) {
    console.log("configuration error src > index.js : ", error.message)
    process.exit(1)
}

ConnectDB()

.then(()=>{
    const port = process.env.PORT || 4000;

    const server = app.listen(port, ()=>{
        console.log(`app running on port http://localhost:${port}/health`)
    })

    // close the listener before the database so an in-flight request finishes
    // instead of being cut off, and never hang forever if it will not
    const shutdown = (signal) => {
        console.log(`${signal} received, closing`)
        server.close(async () => {
            await DisconnectDB()
            process.exit(0)
        })
        setTimeout(() => process.exit(1), 10_000).unref()
    }

    process.on("SIGINT", () => shutdown("SIGINT"))
    process.on("SIGTERM", () => shutdown("SIGTERM"))
})

.catch((error)=>{
    console.log("connection error src > index.js : ", error)
    process.exit(1)
})
