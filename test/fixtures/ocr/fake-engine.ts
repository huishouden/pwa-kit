// A stand-in for tesseract.js (`paths.enginePath`): every image reads as the same label.
export async function createWorker() {
  return {
    recognize: async () => ({ data: { text: 'Lisinopril 10 mg tablets\nTake 1 tablet by mouth daily', blocks: null } }),
    terminate: async () => undefined,
  };
}
