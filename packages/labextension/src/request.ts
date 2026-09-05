import { URLExt } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';

/** URL namespace of the server extension's endpoints. */
export const API_NAMESPACE = 'educates-workshop';

/**
 * Call an endpoint of the server extension and return its JSON response.
 */
export async function requestAPI<T>(
  endPoint: string,
  serverSettings: ServerConnection.ISettings,
  init: RequestInit = {}
): Promise<T> {
  const requestUrl = URLExt.join(
    serverSettings.baseUrl,
    API_NAMESPACE,
    endPoint
  );

  let response: Response;

  try {
    response = await ServerConnection.makeRequest(
      requestUrl,
      init,
      serverSettings
    );
  } catch (error) {
    throw new ServerConnection.NetworkError(error as TypeError);
  }

  // Bodies are JSON on success and usually JSON on failure too.
  const text = await response.text();
  let data: unknown = text;

  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const message =
      typeof data === 'object' &&
      data !== null &&
      typeof (data as { message?: unknown }).message === 'string'
        ? (data as { message: string }).message
        : text;

    throw new ServerConnection.ResponseError(response, message);
  }

  return data as T;
}
