import { readFileSync } from "fs";
import mongoose from "mongoose";
import { asyncHandlers } from "../utils/asyncHandlers.js";
import { ApiResponse } from "../utils/ApiResponse.js";

/**
 * Liveness and readiness.
 *
 * `GET /health` answers without touching the database so a process check stays
 * useful when the database is down; `GET /health/ready` does look, because
 * "connected" is the only thing readiness is about. The payload mirrors the
 * shape the Expo client parses (`HealthReport`), and `database.driver` is what
 * a remote-mode build checks before it trusts the server with production data.
 */
const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8"));

const databaseState = () => {
    const readyState = mongoose.connection.readyState;
    const ok = readyState === 1;
    const driver = ok ? "mongo" : readyState === 2 ? "connecting" : "disconnected";
    return {
        ok,
        driver,
        ...(ok ? {} : { detail: `mongoose connection readyState=${readyState}` })
    };
};

const getHealth = asyncHandlers(async (req, res) => {
    const database = databaseState();

    return res.status(200).json(
        new ApiResponse(200, {
            status: database.ok ? "ok" : "degraded",
            service: "vanta-api",
            version: packageJson.version ?? "1.0.0",
            apiVersion: "v1",
            database,
            config: {
                nodeEnv: process.env.NODE_ENV ?? "development",
                apiVersion: "v1"
            },
            uptimeSeconds: Math.round(process.uptime())
        })
    );
});

/**
 * Always 200: readiness is a report, not a failure. The consumer decides what
 * to do with `ready: false`, and a 503 with an `ok: true` body would trip the
 * client's envelope check before it ever read the flag.
 */
const getReadiness = asyncHandlers(async (req, res) => {
    const database = databaseState();

    return res.status(200).json(
        new ApiResponse(200, {
            ready: database.ok,
            database: { ok: database.ok, driver: database.driver }
        })
    );
});

export { getHealth, getReadiness };
