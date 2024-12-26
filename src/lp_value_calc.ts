import { ethers, ZeroAddress, MaxUint256 } from 'ethers';
import { JsonRpcProvider } from 'ethers';
import { Contract } from 'ethers';
import { Decimal } from 'decimal.js';

interface PositionValue {
    tokenPrice: number;
    tokenXPrice: number;
    tokenYPrice: number;
    positionValue: number;
    unclaimedFees: number;
    totalValue: number;
}

export class V3LpValue {
    private provider: JsonRpcProvider;
    private apiKey: string;
    public priceLower: number = 0;
    public priceUpper: number = 999999999999;

    private readonly tokenAbi = [
        {
            constant: true,
            inputs: [],
            name: "decimals",
            outputs: [{ name: "", type: "uint8" }],
            payable: false,
            stateMutability: "view",
            type: "function"
        }
    ];

    constructor(rpcUrl: string, apiKey: string) {
        this.provider = new JsonRpcProvider(rpcUrl);
        this.apiKey = apiKey;
    }

    // Calculate liquidity
    private calculateV3Liquidity(
        amountX: number,
        amountY: number,
        sqrtPriceCurrent: number,
        sqrtPriceLower: number,
        sqrtPriceUpper: number
    ): number {
        if (sqrtPriceCurrent <= sqrtPriceLower) {
            // Price below range
            return amountX * (sqrtPriceUpper * sqrtPriceLower) / (sqrtPriceUpper - sqrtPriceLower);
        } else if (sqrtPriceCurrent >= sqrtPriceUpper) {
            // Price above range
            return amountY / (sqrtPriceUpper - sqrtPriceLower);
        } else {
            // Price within range
            const lx = amountX * (sqrtPriceUpper * sqrtPriceCurrent) / (sqrtPriceUpper - sqrtPriceCurrent);
            const ly = amountY / (sqrtPriceCurrent - sqrtPriceLower);
            return Math.min(lx, ly);
        }
    }

    // Calculate USD value of liquidity
    private calculatePositionValue(
        liquidity: number,
        currentPrice: number,
        tokenXPriceUsd: number,
        tokenYPriceUsd: number
    ): number {
        const amountX = liquidity / Math.sqrt(currentPrice);
        const amountY = liquidity * Math.sqrt(currentPrice);
        return (amountX * tokenXPriceUsd) + (amountY * tokenYPriceUsd);
    }

    // Get token amounts and unclaimed fees from LP position
    private async getPositionAmounts(
        positionId: number,
        nftContract: Contract,
        poolContract: Contract,
        blockTag?: number
    ): Promise<[number, number, number, number]> {
        const overrides = blockTag ? { blockTag } : {};
        const position = await nftContract.positions(positionId, overrides);
        
        const liquidity = new Decimal(position.liquidity.toString());
        const tickLower = Number(position.tickLower);
        const tickUpper = Number(position.tickUpper);
        
        const slot0 = await poolContract.slot0(overrides);
        const sqrtPriceX96 = new Decimal(slot0.sqrtPriceX96.toString());
        const currentTick = Number(slot0.tick);
        
        const sqrtPriceCurrent = sqrtPriceX96.div(new Decimal(2).pow(96));
        const sqrtPriceLower = new Decimal(1.0001).pow(tickLower / 2);
        const sqrtPriceUpper = new Decimal(1.0001).pow(tickUpper / 2);

        let amount0: Decimal, amount1: Decimal;
        
        if (currentTick < tickLower) {
            amount0 = liquidity.mul(sqrtPriceLower.pow(-1).sub(sqrtPriceUpper.pow(-1)));
            amount1 = new Decimal(0);
        } else if (currentTick > tickUpper) {
            amount0 = new Decimal(0);
            amount1 = liquidity.mul(sqrtPriceUpper.sub(sqrtPriceLower));
        } else {
            amount0 = liquidity.mul(sqrtPriceCurrent.pow(-1).sub(sqrtPriceUpper.pow(-1)));
            amount1 = liquidity.mul(sqrtPriceCurrent.sub(sqrtPriceLower));
        }

        // Get unclaimed fees
        const MAX_UINT128 = "0xffffffffffffffffffffffffffffffff"; // 128-bit max value

        const collectParams = {
            tokenId: positionId,
            recipient: ZeroAddress,
            amount0Max: MAX_UINT128,
            amount1Max: MAX_UINT128
        };

        try {
            const unclaimedFees = await nftContract.collect.staticCall(collectParams, overrides);
            return [
                Number(amount0.toString()),
                Number(amount1.toString()),
                Number(unclaimedFees.amount0.toString()),
                Number(unclaimedFees.amount1.toString())
            ];
        } catch (e) {
            console.error(`Error getting unclaimed fees at block ${blockTag || 'latest'}:`, e);
            return [
                Number(amount0.toString()),
                Number(amount1.toString()),
                0,
                0
            ];
        }
    }

    // Get token price from pool
    private async getTokenPriceFromPool(
        poolContract: Contract,
        isToken0: boolean = true,
        blockTag?: number
    ): Promise<[number, number, number]> {
        const overrides = blockTag ? { blockTag } : {};
        const token0 = await poolContract.token0(overrides);
        const token1 = await poolContract.token1(overrides);
        
        const token0Contract = new Contract(token0, this.tokenAbi, this.provider);
        const token1Contract = new Contract(token1, this.tokenAbi, this.provider);
        
        const decimals0 = Number(await token0Contract.decimals(overrides));
        const decimals1 = Number(await token1Contract.decimals(overrides));
        
        const slot0 = await poolContract.slot0(overrides);
        const sqrtPriceX96 = new Decimal(slot0.sqrtPriceX96.toString());
        
        // Avoid using pow, use multiplication instead
        const Q96 = new Decimal(2).pow(96);
        const sqrtPrice = sqrtPriceX96.div(Q96);
        const price = sqrtPrice.mul(sqrtPrice);
        
        // Use string manipulation for precision adjustment
        const decimalDiff = decimals0 - decimals1;
        const decimalAdjustment = new Decimal('1' + '0'.repeat(Math.abs(decimalDiff)));
        const actualPrice = decimalDiff >= 0 
            ? price.mul(decimalAdjustment)
            : price.div(decimalAdjustment);
        
        return [Number(actualPrice.toString()), decimals0, decimals1];
    }

    // Get contract ABI
    private async getContractAbi(contractAddress: string, chain: 'arbitrum' | 'eth'): Promise<any> {
        const endpoint = chain === 'arbitrum' 
            ? "https://api.arbiscan.io/api"
            : "https://api.etherscan.io/api";
        
        const params = new URLSearchParams({
            module: 'contract',
            action: 'getabi',
            address: contractAddress,
            apikey: this.apiKey
        });

        try {
            const response = await fetch(`${endpoint}?${params}`);
            const data = await response.json();
            if (data.status === '1') {
                return JSON.parse(data.result);
            } else {
                // throw new Error(`Error getting ABI: ${contractAddress} ${data.result}`);
                console.log(`Error getting ABI: ${contractAddress} ${data.result}`);
            }
        } catch (e) {
            console.error("Error:", e);
            return null;
        }
    }

    // Calculate LP position value
    public async calculateLpValue(
        positionManagerAddress: string,
        poolAddress: string,
        positionId: number,
        blockNumber?: number,
        poolXUAddress: string = '',
        poolYUAddress: string = ''
    ): Promise<PositionValue & { blockNumber: number }> {
        // Get contract ABI
        // let positionAbi = await this.getContractAbi(positionManagerAddress, 'arbitrum');
        // if (!positionAbi) {
        //     positionAbi = require('../asset/abi/ERC20/position_manager_address.json');
        // }
        
        // let poolAbi = await this.getContractAbi(poolAddress, 'arbitrum');
        // if (!poolAbi) {
        //     poolAbi = require('../asset/abi/ERC20/pool_address.json');
        // }

        let positionAbi = require('../asset/abi/ERC20/position_manager_address.json');
        let poolAbi = require('../asset/abi/ERC20/pool_address.json');

        const nftContract = new Contract(positionManagerAddress, positionAbi, this.provider);
        const poolContract = new Contract(poolAddress, poolAbi, this.provider);
        
        const [amountX, amountY, feeX, feeY] = await this.getPositionAmounts(
            positionId,
            nftContract,
            poolContract,
            blockNumber
        );
        
        const [tokenPrice, decimals0, decimals1] = await this.getTokenPriceFromPool(
            poolContract,
            true,
            blockNumber
        );

        const tokenXUPrice = poolXUAddress ? 
            (await this.getTokenPriceFromPool(
                new Contract(poolXUAddress, poolAbi, this.provider),
                true,
                blockNumber
            ))[0] : 
            tokenPrice;
            
        const tokenYUPrice = poolYUAddress ? 
            (await this.getTokenPriceFromPool(
                new Contract(poolYUAddress, poolAbi, this.provider),
                true,
                blockNumber
            ))[0] : 
            1;

        const sqrtPriceCurrent = Math.sqrt(tokenPrice);
        const sqrtPriceLower = Math.sqrt(this.priceLower);
        const sqrtPriceUpper = Math.sqrt(this.priceUpper);
        
        const liquidity = this.calculateV3Liquidity(
            amountX / (10 ** decimals0),
            amountY / (10 ** decimals1),
            sqrtPriceCurrent,
            sqrtPriceLower,
            sqrtPriceUpper
        );
        
        const positionValue = this.calculatePositionValue(
            liquidity,
            tokenPrice,
            tokenXUPrice,
            tokenYUPrice
        );
        
        const feeValue = (feeX * tokenXUPrice / (10 ** decimals0)) + 
                        (feeY * tokenYUPrice / (10 ** decimals1));
        
        const currentBlock = blockNumber || await this.provider.getBlockNumber();
        
        return {
            blockNumber: currentBlock,
            tokenPrice,
            tokenXPrice: tokenXUPrice,
            tokenYPrice: tokenYUPrice,
            positionValue,
            unclaimedFees: feeValue,
            totalValue: positionValue + feeValue
        };
    }
}

// Usage example
async function main() {
    // Load configuration
    const config = require('./config.json');
    
    // Set proxy if configured
    if (config.proxy.http && config.proxy.https) {
        process.env.http_proxy = config.proxy.http;
        process.env.https_proxy = config.proxy.https;
    }
    
    // Create client instance
    const client = new V3LpValue(config.network.rpc, config.network.api_key);
    client.priceLower = config.position.price_lower;
    client.priceUpper = config.position.price_upper;
    
    // Calculate LP value
    const result = await client.calculateLpValue(
        config.contracts.position_manager,
        config.contracts.pool,
        config.position.id,
        config.query.block_number
    );
    
    // Print results
    console.log(`Block Number: ${result.blockNumber}`);
    console.log(`Pool Price: ${result.tokenPrice.toFixed(4)}`);
    console.log(`Token X Price: ${result.tokenXPrice.toFixed(4)}`);
    console.log(`Token Y Price: ${result.tokenYPrice.toFixed(4)}`);
    console.log(`Position Value: $${result.positionValue.toFixed(2)}`);
    console.log(`Unclaimed Fees: $${result.unclaimedFees.toFixed(6)}`);
    console.log(`Total Value: $${result.totalValue.toFixed(2)}`);
}

if (require.main === module) {
    main().catch(console.error);
} 