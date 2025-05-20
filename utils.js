const { DOCUMENT_TYPES } = require("./doc_types");


export const validateDocuments = (docs, validations) => {
  if (!docs || docs.length === 0) return false;

  const counts = Array(8).fill(0);
  docs.forEach(doc => counts[doc.type?.value ?? DOCUMENT_TYPES.DEFAULT]++);

  return validations.every(({ type, minCount, condition }) => 
    !condition || counts[type] >= minCount
  );
};

export const isAllDocsValid = (docs, isPrimeBookOrder, isPartRequest, partQuantity) => {
  return validateDocuments(docs, [
    { type: DOCUMENT_TYPES.INVOICE, minCount: 1 },
    { type: DOCUMENT_TYPES.SERIAL_NUMBER, minCount: 1 },
    { type: DOCUMENT_TYPES.DEVICE_PHOTO, minCount: 1 },
    { 
      type: DOCUMENT_TYPES.SELFIE, 
      minCount: 1, 
      condition: isPrimeBookOrder 
    },
    { 
      type: DOCUMENT_TYPES.DEFECTIVE_PART, 
      minCount: partQuantity, 
      condition: isPartRequest 
    }
  ]);
};

export const isCorpDocsValid = (docs, isAc, isPartRequest, partQuantity) => {
  return validateDocuments(docs, [
    { type: DOCUMENT_TYPES.SERIAL_NUMBER, minCount: 1 },
    { type: DOCUMENT_TYPES.DEVICE_PHOTO, minCount: 1 },
    { 
      type: DOCUMENT_TYPES.OUTER_SERIAL_NUMBER, 
      minCount: 1, 
      condition: isAc 
    },
    { 
      type: DOCUMENT_TYPES.DEVICE_PHOTO, 
      minCount: 1, 
      condition: isAc 
    },
    { 
      type: DOCUMENT_TYPES.DEFECTIVE_PART, 
      minCount: partQuantity, 
      condition: isPartRequest 
    }
  ]);
};