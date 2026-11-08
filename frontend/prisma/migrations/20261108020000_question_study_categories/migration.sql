-- CreateTable
CREATE TABLE "question_study_categories" (
    "question_id" BIGINT NOT NULL,
    "study_category_code" VARCHAR(100) NOT NULL,

    CONSTRAINT "question_study_categories_pkey" PRIMARY KEY ("question_id","study_category_code")
);

-- CreateIndex
CREATE INDEX "question_study_categories_study_category_code_question_id_idx" ON "question_study_categories"("study_category_code", "question_id");

-- AddForeignKey
ALTER TABLE "question_study_categories" ADD CONSTRAINT "question_study_categories_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "question_study_categories" ADD CONSTRAINT "question_study_categories_study_category_code_fkey" FOREIGN KEY ("study_category_code") REFERENCES "study_categories"("code") ON DELETE RESTRICT ON UPDATE NO ACTION;
