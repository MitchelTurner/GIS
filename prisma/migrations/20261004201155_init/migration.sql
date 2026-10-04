-- CreateTable
CREATE TABLE "imports" (
    "id" SERIAL NOT NULL,
    "filename" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "feature_count" INTEGER NOT NULL,
    "parcel_count" INTEGER NOT NULL,
    "added" INTEGER NOT NULL,
    "updated" INTEGER NOT NULL,
    "owner_changed" INTEGER NOT NULL,
    "missing" INTEGER NOT NULL,
    "returned" INTEGER NOT NULL,
    "duplicates_dropped" INTEGER NOT NULL,

    CONSTRAINT "imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parcels" (
    "id" SERIAL NOT NULL,
    "parcel_id" TEXT NOT NULL,
    "parcel_no" TEXT,
    "owner_name" TEXT,
    "owner_name_2" TEXT,
    "owner_key" TEXT,
    "owner_signature" TEXT,
    "mailing_address" TEXT,
    "mailing_city" TEXT,
    "mailing_state" TEXT,
    "mailing_zip" TEXT,
    "situs_address" TEXT,
    "situs_city" TEXT,
    "subdivision" TEXT,
    "land_acres" DOUBLE PRECISION,
    "land_sq_ft" DOUBLE PRECISION,
    "area_sq_ft" DOUBLE PRECISION,
    "appraised_cents" BIGINT,
    "taxable_cents" BIGINT,
    "exempt_cents" BIGINT,
    "land_value_cents" BIGINT,
    "improvement_value_cents" BIGINT,
    "exempt_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "zoning" TEXT,
    "prop_use" TEXT,
    "year_built" INTEGER,
    "waterfront_code" INTEGER,
    "deed_ref_date" TEXT,
    "value_history" JSONB NOT NULL DEFAULT '[]',
    "centroid_lat" DOUBLE PRECISION,
    "centroid_lng" DOUBLE PRECISION,
    "geometry" JSONB,
    "raw" JSONB NOT NULL,
    "first_import_id" INTEGER NOT NULL,
    "last_import_id" INTEGER NOT NULL,
    "owner_changed_at" TIMESTAMP(3),
    "previous_owner_name" TEXT,
    "missing_since" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "parcels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "parcels_parcel_id_key" ON "parcels"("parcel_id");

-- CreateIndex
CREATE INDEX "parcels_owner_key_idx" ON "parcels"("owner_key");
