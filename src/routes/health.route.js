import { Router } from "express";
import { getHealth, getReadiness } from "../controllers/health.controller.js";

const router = Router();

// liveness: never touches the database
router.route("/health").get(getHealth);

// readiness: reports the datastore the server is actually using
router.route("/health/ready").get(getReadiness);

export default router;
