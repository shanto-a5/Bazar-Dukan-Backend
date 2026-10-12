import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import { requestId } from "./middlewares/requestId.middleware.js";
import { notFoundHandler, errorHandler } from "./middlewares/error.middleware.js";




const app = express();

// no version banner for scanners to fingerprint
app.disable("x-powered-by")

// first: every log line and every error payload can name this request
app.use(requestId)

// FIXES 12 (no helmet — the API answers JSON, never HTML, so the inline trio
// below is cheaper and quieter): only forward cookies once the deployment
// names a concrete origin. A wildcard or missing CORS_ORIGIN must NOT set
// `credentials: true` — browsers reject the pair ("*" + credentials), so
// shipping it today would break every browser session the moment CORS_ORIGIN
// is left unset.
const corsOrigin = process.env.CORS_ORIGIN;
const allowCredentials = typeof corsOrigin === "string" && corsOrigin.trim() !== "" && corsOrigin.trim() !== "*";

app.use(cors({
    origin : corsOrigin,
    credentials : allowCredentials,
    exposedHeaders : ["x-request-id", "retry-after"]
}))

// header strictness for every answer, immediately after the request id is attached
app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    return next();
})


app.use(express.urlencoded({limit: "16kb",extended : true}))
app.use(express.json({limit: "16kb"}))
app.use(express.static('public'))
app.use(cookieParser())


// import router
import userRouter from "./routes/user.route.js"
import healthRouter from "./routes/health.route.js";
import sellerRouter from "./routes/seller.route.js"
import categoryRouter from "./routes/category.route.js"
import sellerProductRouter from "./routes/seller-product.route.js"
import voucherRouter from "./routes/voucher.route.js"
import notificationRouter from "./routes/notification.route.js"
import cartRouter from "./routes/cart.route.js"
import orderRouter from "./routes/order.route.js"
import catalogRouter from "./routes/catalog.route.js"
import metaRouter from "./routes/meta.route.js"
import returnRouter from "./routes/return.route.js"
import reviewRouter from "./routes/review.route.js"
import wishlistRouter from "./routes/wishlist.route.js"
import addressRouter from "./routes/address.route.js"
import recentlyViewedRouter from "./routes/recently-viewed.route.js"
import followRouter from "./routes/follow.route.js"
import sellerMediaRouter from "./routes/seller-media.route.js"



// capability (no auth, no datastore writes)
app.use("/api/v1", healthRouter);

// route
app.use("/api/v1/auth", userRouter);

// marketplace slices (M12)
app.use("/api/v1", sellerRouter);
app.use("/api/v1", categoryRouter);
app.use("/api/v1", sellerProductRouter);
app.use("/api/v1", voucherRouter);
app.use("/api/v1", notificationRouter);
app.use("/api/v1", cartRouter);
app.use("/api/v1", orderRouter);
app.use("/api/v1", catalogRouter);
app.use("/api/v1", metaRouter);
app.use("/api/v1", returnRouter);
app.use("/api/v1", reviewRouter);

// account + engagement slices (M13)
app.use("/api/v1", wishlistRouter);
app.use("/api/v1", addressRouter);
app.use("/api/v1", recentlyViewedRouter);
app.use("/api/v1", followRouter);
app.use("/api/v1", sellerMediaRouter);


// unknown routes and thrown errors both answer in the Vanta envelope
app.use(notFoundHandler)
app.use(errorHandler)


export{app};
