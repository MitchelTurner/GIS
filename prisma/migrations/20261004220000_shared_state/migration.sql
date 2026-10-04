-- CreateTable
CREATE TABLE "shared_state" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shared_state_pkey" PRIMARY KEY ("key")
);

