/**
 * Vanta seed — the reference taxonomy plus one demo marketplace.
 *
 * Run from `new_backend`:
 *
 *     node src/seed/seed.js
 *
 * Idempotent by construction: every row is written through an upsert keyed on
 * its own natural key (category name within a parent, user email, profile per
 * user, store per seller, product SKU per seller, voucher code), so re-running
 * updates the same documents instead of duplicating them. It writes only what
 * it names below — categories, one demo seller with one store, eight demo
 * products and one platform voucher — and touches nothing a real person created.
 *
 * The demo password is generated fresh on every run (bcrypt cost from
 * `bcryptRounds()`), printed to stdout ONCE as `Demo seller password: <value>`
 * and never written anywhere else; it is deliberately not a hard-coded
 * credential, so a seeded database cannot ship with a known one.
 *
 * Connects with `MONGODB_URI` from `.env` and the application database name
 * `DB_Name` ("UP"), the same connection string shape as `src/db/index.js`.
 * `SEED_DB_NAME` overrides only the database name (defaulting to `DB_Name`),
 * which exists so a seed can be rehearsed against a scratch database instead
 * of the shared one.
 */
import "dotenv/config";
import crypto from "node:crypto";
import bcrypt from "bcrypt";
import mongoose from "mongoose";

import { DB_Name, bcryptRounds } from "../constance.js";
import { User } from "../models/user.model.js";
import { SellerProfile } from "../models/seller-profile.model.js";
import { Store } from "../models/store.model.js";
import { Category } from "../models/category.model.js";
import { Product } from "../models/product.model.js";
import { Voucher } from "../models/voucher.model.js";
import * as categoryRepo from "../repositories/category.repository.js";

// ------------------------------------------------------------------ taxonomy

/**
 * The simulator's `CATEGORY_TAXONOMY` (`src/taxonomy/index.ts`), copied
 * verbatim: top-level category with its icon and the subcategories a listing
 * can be filed under. This is the marketplace's fixed vocabulary — reference
 * data, not content.
 */
const CATEGORY_TAXONOMY = [
    { name: "Groceries", icon: "\u{1F6D2}", subcategories: ["Fresh Produce", "Dairy & Eggs", "Beverages", "Snacks", "Staples", "Baking"] },
    { name: "Men's Fashion", icon: "\u{1F454}", subcategories: ["T-Shirts", "Shirts", "Pants & Jeans", "Kurtas", "Clothing Sets", "Accessories"] },
    { name: "Women's Fashion", icon: "\u{1F457}", subcategories: ["Dresses", "Tops & Blouses", "Hijabs", "Jeans", "Kurtis", "Handbags"] },
    { name: "Kids' Fashion", icon: "\u{1F9F8}", subcategories: ["Boys' Clothing", "Girls' Clothing", "Baby Wear", "Kids Footwear", "School Wear"] },
    { name: "Shoes & Footwear", icon: "\u{1F45F}", subcategories: ["Sneakers", "Formal Shoes", "Sandals", "Heels", "Sports Shoes", "Boots"] },
    { name: "Mobiles & Tablets", icon: "\u{1F4F1}", subcategories: ["Smartphones", "Feature Phones", "Tablets", "Cases & Covers", "Power Banks", "Chargers & Cables"] },
    { name: "Laptops & Computers", icon: "\u{1F4BB}", subcategories: ["Laptops", "Desktops", "Monitors", "Keyboards & Mice", "Storage", "Networking"] },
    { name: "Electronics", icon: "\u{1F50C}", subcategories: ["Televisions", "Audio & Speakers", "Headphones", "Cameras", "Wearables", "Smart Gadgets"] },
    { name: "Home & Living", icon: "\u{1F6CB}\u{FE0F}", subcategories: ["Furniture", "Home Decor", "Lighting", "Storage & Organization", "Bedding"] },
    { name: "Kitchen & Dining", icon: "\u{1F373}", subcategories: ["Cookware", "Bakeware", "Utensils", "Tableware", "Kitchen Appliances"] },
    { name: "Beauty & Personal Care", icon: "\u{1F484}", subcategories: ["Makeup", "Skincare", "Hair Care", "Fragrance", "Beauty Tools"] },
    { name: "Health & Wellness", icon: "\u{1F48A}", subcategories: ["Vitamins & Supplements", "Fitness Equipment", "First Aid", "Wellness Devices", "Oral Care"] },
    { name: "Sports & Outdoors", icon: "\u26BD", subcategories: ["Fitness", "Outdoor Sports", "Camping", "Cycling", "Cricket"] },
    { name: "Toys & Games", icon: "\u{1F9E9}", subcategories: ["Action Figures", "Educational Toys", "Board Games", "Remote Control", "Soft Toys"] },
    { name: "Books & Stationery", icon: "\u{1F4DA}", subcategories: ["Books", "Notebooks", "Pens & Markers", "Art Supplies", "Office Supplies"] },
    { name: "Automotive", icon: "\u{1F697}", subcategories: ["Car Accessories", "Bike Accessories", "Car Care", "Interior Accessories", "Tyres"] },
    { name: "Baby & Maternity", icon: "\u{1F37C}", subcategories: ["Diapers", "Baby Care", "Feeding", "Nursery", "Maternity"] },
    { name: "Pets & Supplies", icon: "\u{1F43E}", subcategories: ["Dog Food", "Cat Food", "Pet Accessories", "Grooming", "Aquarium"] },
    { name: "Home Appliances", icon: "\u{1F9FA}", subcategories: ["Refrigerators", "Washing Machines", "Air Conditioners", "Fans", "Irons", "Vacuums"] },
    { name: "Jewellery & Watches", icon: "\u{1F48D}", subcategories: ["Women's Jewellery", "Men's Jewellery", "Watches", "Sunglasses", "Brooches"] }
];

/** The simulator's slug rule: the palette-image seed for each category. */
const slug = (input) =>
    input
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");

// -------------------------------------------------------------- demo content

const DEMO_EMAIL = "seller.demo@vanta.local";
const DEMO_STORE_NAME = "Demo Store";

/** Unique per seller, which is what makes the product upsert idempotent. */
const DEMO_PRODUCTS = [
    {
        sku: "DEMO-001",
        name: "Sunrise Basmati Rice 5kg",
        brand: "Sunrise Foods",
        categoryName: "Groceries",
        subcategoryName: "Staples",
        description: "Aged long-grain basmati, stone-milled and packed the same week it ships.",
        highlights: ["Aged 2 years", "Stone milled", "5kg pack"],
        regularPrice: 720,
        salePrice: 660,
        stock: 80,
        lowStockThreshold: 10,
        status: "active"
    },
    {
        sku: "DEMO-002",
        name: "Aurora X5 Smartphone 128GB",
        brand: "Aurora",
        categoryName: "Mobiles & Tablets",
        subcategoryName: "Smartphones",
        description: "6.5-inch AMOLED display, 50MP triple camera and a 5000mAh battery.",
        highlights: ["6.5in AMOLED", "50MP camera", "5000mAh battery"],
        regularPrice: 15999,
        salePrice: 14999,
        stock: 3,
        lowStockThreshold: 5,
        status: "active"
    },
    {
        sku: "DEMO-003",
        name: "PulseSound Pro Wireless Headphones",
        brand: "PulseSound",
        categoryName: "Electronics",
        subcategoryName: "Headphones",
        description: "Over-ear headphones with active noise cancelling and 40-hour playback.",
        highlights: ["Active noise cancelling", "40h playback", "USB-C fast charge"],
        regularPrice: 4500,
        salePrice: null,
        stock: 0,
        lowStockThreshold: 5,
        status: "out_of_stock"
    },
    {
        sku: "DEMO-004",
        name: "Craftloom Handwoven Jute Rug 4x6 ft",
        brand: "Craftloom",
        categoryName: "Home & Living",
        subcategoryName: "Home Decor",
        description: "Handwoven jute rug with a natural herringbone weave, finished by artisans.",
        highlights: ["Handwoven", "Natural jute", "4x6 ft"],
        regularPrice: 3200,
        salePrice: null,
        stock: 12,
        lowStockThreshold: 4,
        status: "draft"
    },
    {
        sku: "DEMO-005",
        name: "Urban Weave Linen Shirt",
        brand: "Urban Weave",
        categoryName: "Men's Fashion",
        subcategoryName: "Shirts",
        description: "Breathable European linen shirt cut for a relaxed everyday fit.",
        highlights: ["100% linen", "Relaxed fit", "Machine washable"],
        regularPrice: 1450,
        salePrice: 1290,
        stock: 24,
        lowStockThreshold: 6,
        status: "paused"
    },
    {
        sku: "DEMO-006",
        name: "Classic Cotton T-Shirt",
        brand: "Urban Weave",
        categoryName: "Men's Fashion",
        subcategoryName: "T-Shirts",
        description: "Mid-weight combed cotton tee, available in three sizes.",
        highlights: ["Combed cotton", "Mid weight", "Pre-shrunk"],
        regularPrice: 799,
        salePrice: null,
        stock: 25,
        lowStockThreshold: 8,
        status: "active",
        variants: [
            { size: "S", stock: 8 },
            { size: "M", stock: 10 },
            { size: "L", stock: 7 }
        ]
    },
    {
        sku: "DEMO-007",
        name: "FrostCore 250L Refrigerator",
        brand: "FrostCore",
        categoryName: "Home Appliances",
        subcategoryName: "Refrigerators",
        description: "250 litre frost-free refrigerator with a convertible freezer compartment.",
        highlights: ["250L capacity", "Frost free", "5 year compressor warranty"],
        regularPrice: 32990,
        salePrice: 30990,
        stock: 6,
        lowStockThreshold: 2,
        status: "active"
    },
    {
        sku: "DEMO-008",
        name: "VitaCore Vitamin C 1000mg",
        brand: "VitaCore",
        categoryName: "Health & Wellness",
        subcategoryName: "Vitamins & Supplements",
        description: "One-a-day vitamin C tablets with rosehip, 60 tablets per bottle.",
        highlights: ["1000mg per tablet", "60 tablets", "With rosehip"],
        regularPrice: 850,
        salePrice: 765,
        stock: 45,
        lowStockThreshold: 10,
        status: "active"
    }
];

/** The simulator's placeholder scheme for product imagery: `p:🛍️:<name>`. */
const productImage = (name) => `p:\u{1F6CD}\u{FE0F}:${name}`;

// ------------------------------------------------------------------- seeding

const seedCategories = async () => {
    const byKey = new Map();
    let written = 0;
    let topLevelOrder = 0;

    for (const entry of CATEGORY_TAXONOMY) {
        const parentSeed = `cat_${slug(entry.name)}`;
        const parent = await categoryRepo.upsert(
            { name: entry.name, parentId: null },
            {
                name: entry.name,
                icon: entry.icon,
                image: `p:${entry.icon}:${parentSeed}`,
                parentId: null,
                order: topLevelOrder
            }
        );
        byKey.set(entry.name, parent);
        written += 1;

        for (const [index, sub] of entry.subcategories.entries()) {
            const child = await categoryRepo.upsert(
                { name: sub, parentId: parent._id },
                {
                    name: sub,
                    icon: entry.icon,
                    image: `p:${entry.icon}:${parentSeed}_${slug(sub)}`,
                    parentId: parent._id,
                    order: index
                }
            );
            byKey.set(`${entry.name}/${sub}`, child);
            written += 1;
        }

        topLevelOrder += 1;
    }

    return { written, byKey };
};

const seedDemoSeller = async () => {
    // Fresh every run and printed once: a seeded database must never carry a
    // credential somebody knows in advance.
    const password = `Vanta-${crypto.randomBytes(9).toString("base64url")}`;
    const passwordSalt = await bcrypt.genSalt(bcryptRounds());
    const passwordHash = await bcrypt.hash(password, passwordSalt);

    const user = await User.findOneAndUpdate(
        { email: DEMO_EMAIL },
        {
            $set: {
                name: "Demo Seller",
                phone: "01700000000",
                passwordHash,
                passwordSalt,
                avatar: `p:\u{1F464}:${DEMO_EMAIL}`,
                roles: ["customer", "seller"]
            }
        },
        { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    const now = new Date();
    const profile = await SellerProfile.findOneAndUpdate(
        { userId: user._id },
        {
            $set: {
                fullName: "Demo Seller",
                phone: "01700000000",
                email: DEMO_EMAIL,
                nationalId: "VANTA-DEMO-0001",
                sellerType: "individual",
                entityName: "",
                storeName: DEMO_STORE_NAME,
                storeDescription: "The seeded demo storefront: sample products across the catalog.",
                logo: `p:\u{1F3EA}:${DEMO_STORE_NAME}`,
                banner: `p:\u{1F6D2}:${DEMO_STORE_NAME}`,
                pickupDivision: "Dhaka",
                pickupDistrict: "Dhaka",
                pickupArea: "Dhanmondi",
                pickupAddressLine: "House 12, Road 5, Dhanmondi",
                returnDivision: "Dhaka",
                returnDistrict: "Dhaka",
                returnArea: "Dhanmondi",
                returnAddressLine: "House 12, Road 5, Dhanmondi",
                bank: {
                    bankName: "Demo Bank",
                    accountName: "Demo Seller",
                    accountNumber: "01234567890",
                    branch: "Dhanmondi"
                },
                agreement: {
                    marketplaceTerms: true,
                    sellerPolicies: true,
                    productAuthenticity: true,
                    fulfillmentResponsibility: true
                },
                status: "active",
                appliedAt: now,
                decidedAt: now,
                decisionNote: ""
            }
        },
        { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    // The simulator's store creation defaults: fee 60, free over 999, 2–4 days,
    // response rate 100, verified, store active.
    const store = await Store.findOneAndUpdate(
        { sellerId: profile._id },
        {
            $set: {
                name: DEMO_STORE_NAME,
                description: "The seeded demo storefront: sample products across the catalog.",
                logo: `p:\u{1F3EA}:${DEMO_STORE_NAME}`,
                banner: `p:\u{1F6D2}:${DEMO_STORE_NAME}`,
                status: "active",
                ratingAvg: 0,
                ratingCount: 0,
                responseRate: 100,
                responseTimeMinutes: 120,
                followerCount: 0,
                shippingFee: 60,
                freeShippingThreshold: 999,
                deliveryEstimateDays: { min: 2, max: 4 },
                location: "Dhaka, Dhaka",
                verified: true
            }
        },
        { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    return { user, profile, store, password };
};

const seedProducts = async (profile, store, categoryByKey) => {
    let written = 0;

    for (const definition of DEMO_PRODUCTS) {
        const category = categoryByKey.get(definition.categoryName);
        if (!category) throw new Error(`Missing seeded category: ${definition.categoryName}`);
        const subcategory = definition.subcategoryName
            ? categoryByKey.get(`${definition.categoryName}/${definition.subcategoryName}`)
            : null;

        const variants = (definition.variants ?? []).map((variant) => ({
            sku: `${definition.sku}-${variant.size}`,
            attributes: { size: variant.size },
            price: definition.salePrice ?? definition.regularPrice,
            compareAtPrice: definition.regularPrice,
            stock: variant.stock,
            image: productImage(definition.name)
        }));

        // When a product has variants its own `stock` is the aggregate across
        // them — the number checkout and the low-stock rule both read.
        const stock = variants.length > 0
            ? variants.reduce((total, variant) => total + variant.stock, 0)
            : definition.stock;

        await Product.findOneAndUpdate(
            { sellerId: profile._id, sku: definition.sku },
            {
                $set: {
                    sellerId: profile._id,
                    storeId: store._id,
                    name: definition.name,
                    brand: definition.brand,
                    categoryId: category._id,
                    subcategoryId: subcategory ? subcategory._id : null,
                    description: definition.description,
                    highlights: definition.highlights,
                    images: [productImage(definition.name)],
                    video: null,
                    regularPrice: definition.regularPrice,
                    salePrice: definition.salePrice,
                    costPrice: null,
                    sku: definition.sku,
                    stock,
                    lowStockThreshold: definition.lowStockThreshold,
                    variants,
                    hasVariants: variants.length > 0,
                    status: definition.status,
                    publishedAt: definition.status === "active" ? new Date() : null,
                    ratingAvg: 0,
                    ratingCount: 0,
                    soldCount: 0,
                    viewCount: 0,
                    isNewArrival: false
                }
            },
            { new: true, upsert: true, setDefaultsOnInsert: true }
        );
        written += 1;
    }

    return written;
};

const seedVoucher = async () => {
    const now = Date.now();
    await Voucher.findOneAndUpdate(
        { code: "DEMO10" },
        {
            $set: {
                code: "DEMO10",
                title: "Demo 10% off",
                type: "percentage",
                discountValue: 10,
                minimumOrder: 500,
                maximumDiscount: 100,
                scope: "platform",
                sellerId: null,
                categoryId: null,
                productIds: [],
                startAt: new Date(now - 86_400_000),
                expiry: new Date(now + 90 * 86_400_000),
                usageLimit: null,
                usageCount: 0,
                perUserLimit: null,
                perUserUsed: {},
                active: true,
                description: "10% off orders over 500, capped at 100. Seeded demo voucher."
            }
        },
        { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    return 1;
};

// --------------------------------------------------------------------- main

const seed = async () => {
    const base = (process.env.MONGODB_URI ?? "").trim().replace(/\/+$/, "");
    if (!base) throw new Error("MONGODB_URI is required to run the seed.");

    const dbName = (process.env.SEED_DB_NAME ?? "").trim() || DB_Name;
    await mongoose.connect(`${base}/${dbName}`);

    try {
        const { written: categories, byKey } = await seedCategories();
        const { user, profile, store, password } = await seedDemoSeller();
        const products = await seedProducts(profile, store, byKey);

        // `productCount` is a denormalised aggregate, so it is rewritten to the
        // number of products this run actually has on file.
        await Store.updateOne({ _id: store._id }, { $set: { productCount: products } });

        const vouchers = await seedVoucher();

        console.log(
            `Seeded vanta [${dbName}]: categories=${categories} users=1 sellers=1 stores=1 products=${products} vouchers=${vouchers}`
        );
        console.log(`Demo seller password: ${password}`);
        console.log(`Demo seller sign-in: ${user.email}`);
    } finally {
        await mongoose.disconnect();
    }
};

seed().catch((error) => {
    console.error(`Seed failed: ${error.message}`);
    process.exitCode = 1;
});
