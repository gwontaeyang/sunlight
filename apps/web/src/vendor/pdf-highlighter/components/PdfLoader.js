// Modified for study_paper (S0, pdf.js 6.5.438 + React 19): removed the unpkg.com default worker URL (CSP: same-origin only, workerSrc is now required); cleanup no longer calls PDFDocumentProxy.destroy(), which pdf.js 6 removed; a superseded load (React StrictMode double effect) is ignored instead of showing "Loading aborted"; the loaded document is state, not a ref.
// Modified for study_paper (M1, review M10): the load state (document, error, progress) is tagged with the `document` prop it belongs to and reset when a new load starts, so a new document never shows the previous error, progress or document (failure → success, fast paper changes, StrictMode double effect); onError is read from a ref (latest callback, not part of the load effect).
import React, { useEffect, useRef, useState } from "react";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
const DEFAULT_BEFORE_LOAD = (progress) => (React.createElement("div", { style: { color: "black" } },
    "Loading ",
    Math.floor((progress.loaded / progress.total) * 100),
    "%"));
const DEFAULT_ERROR_MESSAGE = (error) => (React.createElement("div", { style: { color: "black" } }, error.message));
const DEFAULT_ON_ERROR = (error) => {
    throw new Error(`Error loading PDF document: ${error.message}!`);
};
const EMPTY = { source: null, pdfDocument: null, error: null, progress: null };
/**
 * A component for loading a PDF document and passing it to a child.
 *
 * @category Component
 */
export const PdfLoader = ({ document, beforeLoad = DEFAULT_BEFORE_LOAD, errorMessage = DEFAULT_ERROR_MESSAGE, children, onError = DEFAULT_ON_ERROR, workerSrc, }) => {
    if (!workerSrc)
        throw new Error("PdfLoader: workerSrc is required (no CDN default)");
    const pdfLoadingTaskRef = useRef(null);
    const onErrorRef = useRef(onError);
    onErrorRef.current = onError;
    // study_paper: one state object tagged with the `document` it was produced for. State of another document
    // is ignored at render time, and updates from a superseded load are dropped.
    const [load, setLoad] = useState(EMPTY);
    // Intitialise document
    useEffect(() => {
        let cancelled = false;
        const source = document;
        const update = (patch) => {
            if (!cancelled)
                setLoad((prev) => ({ ...(prev.source === source ? prev : { ...EMPTY, source }), ...patch }));
        };
        // Reset at the start of every load: no error/progress/document of a previous load survives.
        setLoad({ ...EMPTY, source });
        GlobalWorkerOptions.workerSrc = workerSrc;
        const task = getDocument(source);
        pdfLoadingTaskRef.current = task;
        task.onProgress = (progress) => {
            update({ progress: progress.loaded > progress.total ? null : progress });
        };
        task.promise
            .then((doc) => {
            update({ pdfDocument: doc, progress: null });
        })
            .catch((error) => {
            if (!cancelled && error?.message != "Worker was destroyed") {
                update({ error, progress: null, pdfDocument: null });
                onErrorRef.current(error);
            }
        });
        return () => {
            cancelled = true;
            task.destroy();
            // PDFDocumentProxy.destroy() does not exist in pdf.js 6; the loading task's destroy() above
            // already tears the document down.
            if (pdfLoadingTaskRef.current === task)
                pdfLoadingTaskRef.current = null;
        };
    }, [document]);
    const current = load.source === document ? load : EMPTY;
    return current.error
        ? errorMessage(current.error)
        : current.progress
            ? beforeLoad(current.progress)
            : current.pdfDocument && children(current.pdfDocument);
};
