import { Router } from "express";
import { listCategories } from "../controllers/category.controller.js";

/**
 * Public catalog routes. The path is the FULL one (`/catalog/categories`), so
 * the router mounts straight onto the API prefix
 * (`app.use("/api/v1", categoryRouter)`).
 *
 * Deliberately no `authenticate`: the category vocabulary is what a browser
 * sees before anyone signs in, and the simulator's taxonomy ships the same way.
 */
const router = Router();

router.route("/catalog/categories").get(listCategories);

export default router;
