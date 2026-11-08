import assert from 'node:assert/strict'
import test from 'node:test'
import {filterStudyQuestionCatalog} from '../app/utils/studyQuestionCatalog.ts'
const catalog=[{exam_number:1,question_numbers:[1,2,3],question_study_codes:{1:['part_one','leaf_a','scope_one'],2:['part_one','leaf_b','scope_one'],3:['part_two','leaf_c','scope_two']}}]
test('taxonomy preview uses union within a selection and intersection between schemes without mutating source',()=>{
 assert.deepEqual(filterStudyQuestionCatalog(catalog,{study_category_codes:'leaf_a,leaf_c'})[0]?.question_numbers,[1,3])
 assert.deepEqual(filterStudyQuestionCatalog(catalog,{study_part_code:'part_one',study_section_code:'leaf_b'})[0]?.question_numbers,[2])
 assert.deepEqual(filterStudyQuestionCatalog(catalog,{study_category_codes:'part_one',study_scope_codes:'scope_two'})[0]?.question_numbers,[])
 assert.deepEqual(filterStudyQuestionCatalog(catalog,{study_category_codes:'unknown'})[0]?.question_numbers,[])
 assert.deepEqual(catalog[0]?.question_numbers,[1,2,3])
})
