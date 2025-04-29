class DocType {
  constructor(name, value) {
    this.name = name;
    this.value = value;
  }
}

class RequiredDocumentData {
  static invoice = new DocType("Invoice", 0);
  static serialNo = new DocType("Sr. #", 1);
  static devicePhoto = new DocType("Device Photo", 2);
}

class DocumentTypeData {
  static invoice = new DocType("Invoice", 0);
  static serialNo = new DocType("Sr. #", 1);
  static deviceVideo = new DocType("Device Video", 2);
  static devicePhoto = new DocType("Device Photo", 3);
  static defectivePickup = new DocType("Defective Pickup", 6);
  static jobsheet = new DocType("Jobsheet", 7);
  static other = new DocType("Other", 4);
  static technicianSelfie = new DocType("Selfie of Technician", 5);
}

class CorpDocumentTypeData {
  static serialNo = new DocType("Sr. #", 0);
  static devicePhoto = new DocType("Device Photo", 1);
  static jobsheet = new DocType("Jobsheet", 7);
  static innerSerialNo = new DocType("Inner Sr. #", 0);
  static innerDevicePhoto = new DocType("Inner Device Photo", 1);
  static outerSerialNo = new DocType("Outer Sr. #", 2);
  static outerDevicePhoto = new DocType("Outer Device Photo", 3);
}

module.exports = { DocType, RequiredDocumentData };
