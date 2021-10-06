// thaw-mongodb-web-service/src/main.ts

import { ifDefinedThenElse } from 'thaw-common-utilities.ts';

import { IMongoDBClient, IMongoDBCollection } from 'thaw-types';

import { createDirectMongoDBClient } from 'thaw-mongodb-client-direct';

import {
	HttpServerBase,
	IHttpServerRequestContext,
	IHttpServerResponseData
} from 'thaw-http-server-base';

const mongoDBServerName = 'localhost';
const mongoDBServerPort = 27017;

// REST API:
// - GET    http://server:port/database/collection : Read all items in collection
// - GET    http://server:port/database/collection/id : Read the item in collection such that item._id === id. Returns 200 (found) or 404 (not found)
// - POST   http://server:port/database/collection : Insert an item into the collection
// - PUT    http://server:port/database/collection/id : Update (or upsert?) the item from the collection where item._id === id. Returns 200 (found) or 404 (not found)
// - DELETE http://server:port/database/collection : Delete an item from the collection
// - DELETE http://server:port/database/collection/id : Delete the item from the collection where item._id === id. Returns 200 (found) or 404 (not found)

// To test using curl:
// Create one: curl --header "Content-Type: application/json" --request POST --data '{"key1":"value1"}' http://localhost/test1/collection1

// Read one: e.g. curl http://localhost/test1/collection1/60216a13dafcf08dc33765ca
// Read all: curl http://localhost/test1/collection1

// Delete one: e.g. curl -X DELETE http://localhost:/test1/collection1/60216a13dafcf08dc33765ca
// Delete all: curl -X DELETE http://localhost:/test1/collection1

interface IOperatorOptions {
	id?: string;
	requestBody?: string; // For HTTP POST, PUT, and PATCH
	record?: unknown; // For HTTP POST and PUT
	// update?: unknown; // For HTTP PATCH
	successStatusCode?: number;
}

type OperatorType = (
	collection: IMongoDBCollection,
	options: IOperatorOptions
) => Promise<unknown | undefined>;

const fnPost = async (
	collection: IMongoDBCollection,
	options: IOperatorOptions = {}
): Promise<unknown> => {
	if (typeof options.record === 'undefined') {
		throw new Error('fnPost() : options.record is undefined');
	}

	return await collection.createOne(options.record);
};

const fnGetOne = async (
	collection: IMongoDBCollection,
	options: IOperatorOptions = {}
): Promise<unknown> => {
	if (typeof options.id === 'undefined') {
		throw new Error('fnGetOne() : options.id is undefined');
	}

	return await collection.readOneById(options.id);
};

const fnGetAll = async (
	collection: IMongoDBCollection,
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	options: IOperatorOptions = {}
): Promise<unknown[]> => {
	return await collection.readAll();
};

const fnPutOne = async (
	collection: IMongoDBCollection,
	options: IOperatorOptions = {}
): Promise<unknown> => {
	if (typeof options.id === 'undefined') {
		throw new Error('fnPutOne() : options.id is undefined');
	} else if (typeof options.record === 'undefined') {
		throw new Error('fnPutOne() : options.record is undefined');
	}

	return await collection.replaceOneById(options.id, options.record);
};

const fnPatchOne = async (
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	collection: IMongoDBCollection,
	options: IOperatorOptions = {}
): Promise<unknown> => {
	if (typeof options.id === 'undefined') {
		throw new Error('fnPatchOne() : options.id is undefined');
	}

	// return await collection.updateOneById(options.id, options.update);

	throw new Error('fnPatchOne() : Not yet implemented');
};

const fnDeleteOne = async (
	collection: IMongoDBCollection,
	options: IOperatorOptions = {}
): Promise<unknown> => {
	if (typeof options.id === 'undefined') {
		throw new Error('fnGetOne() : options.id is undefined');
	}

	return await collection.deleteOneById(options.id);
};

const fnDeleteAll = async (
	collection: IMongoDBCollection,
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	options: IOperatorOptions = {}
): Promise<boolean> => {
	return await collection.deleteAll();
};

async function handleHttpMethod(
	databaseName: string,
	collectionName: string,
	fnOperator: OperatorType,
	options: IOperatorOptions = {}
): Promise<IHttpServerResponseData> {
	if (typeof options.id !== 'undefined' && options.id.length !== 24) {
		console.error(`ID '${options.id}' : Wrong length for a MongoDB record ID.`);

		return { statusCode: 400 }; // Bad request
	}

	let client: IMongoDBClient | undefined;

	try {
		client = createDirectMongoDBClient({
			server: mongoDBServerName,
			port: mongoDBServerPort
		});

		await client.connect();

		const collection = client.getDatabase(databaseName).getCollection(collectionName);

		if (typeof options.requestBody !== 'undefined') {
			// TODO: Also check the request headers for "Content-Type: application/json" ?
			try {
				options.record = JSON.parse(options.requestBody);
			} catch (error) {
				console.error('JSON.parse() error:', typeof error, error);
				console.error(
					'This request body could not be parsed as JSON:\n',
					options.requestBody
				);

				return { statusCode: 400 }; // Bad request
			}
		}

		const result = await fnOperator(collection, options);
		const statusCode = ifDefinedThenElse(options.successStatusCode, 200);

		if (result) {
			return {
				statusCode,
				responseBody: JSON.stringify(result), // TODO: This might need to be fixed, e.g. in case of DELETE
				isResponseBodyJson: true // TODO: This might need to be fixed
			};
		} else {
			return { statusCode };
		}
	} finally {
		if (typeof client !== 'undefined') {
			await client.destroy();
		}
	}
}

class HttpServer extends HttpServerBase {
	constructor() {
		super();

		this.arh('POST', 2, fnPost, false, true, 201);
		this.arh('GET', 2, fnGetAll);
		this.arh('GET', 3, fnGetOne, true);
		this.arh('PUT', 3, fnPutOne, true, true);
		this.arh('PATCH', 3, fnPatchOne, true, true);
		this.arh('DELETE', 2, fnDeleteAll);
		this.arh('DELETE', 3, fnDeleteOne, true);

		// HEAD is handled the same as GET, except that the response to a HEAD request will have no body.
		this.arh('HEAD', 3, fnGetOne, true);

		// this.addRequestHandler('OPTIONS', ?, ?);
	}

	private arh(
		m: string,
		n: number,
		fn: OperatorType,
		id = false,
		body = false,
		code = 200
	): void {
		this.addRequestHandler(
			m,
			n,
			async (urlComponents: string[], context: IHttpServerRequestContext) =>
				await handleHttpMethod(urlComponents[0], urlComponents[1], fn, {
					id: id ? urlComponents[2] : undefined,
					requestBody: body ? context.requestBody : undefined,
					successStatusCode: code
				})
		);
	}
}

new HttpServer()
	.listen()
	.then()
	.catch((error: unknown) => {
		console.error('Outermost catch: serverObject.listen() : error is', typeof error, error);
	});
