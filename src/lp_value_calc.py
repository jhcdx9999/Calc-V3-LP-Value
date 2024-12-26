from math import sqrt
from web3 import Web3
from decimal import Decimal
from numpy import inf
import json
import time
import os
import requests


class v3_lp_value:
    def __init__(self, rpc_url, api_key):
        """
        rpc_url: RPC node URL
        api_key: Arbiscan API key
        """
        self.w3 = Web3(Web3.HTTPProvider(rpc_url))
        self.api_key = api_key
        
        # Base token contract ABI
        self.token_abi = [
            {
                "constant": True,
                "inputs": [],
                "name": "decimals",
                "outputs": [{"name": "", "type": "uint8"}],
                "payable": False,
                "stateMutability": "view",
                "type": "function"
            }
        ]


    # Calculate liquidity
    def calculate_v3_liquidity(self, amount_x, amount_y, sqrt_price_current, sqrt_price_lower, sqrt_price_upper):
        """
        amount_x: Amount of token X
        amount_y: Amount of token Y
        sqrt_price_current: Square root of current price
        sqrt_price_lower: Square root of lower price bound
        sqrt_price_upper: Square root of upper price bound
        """
        if sqrt_price_current <= sqrt_price_lower:
            # Price below range
            liquidity = amount_x * (sqrt_price_upper * sqrt_price_lower) / (sqrt_price_upper - sqrt_price_lower)
        elif sqrt_price_current >= sqrt_price_upper:
            # Price above range
            liquidity = amount_y / (sqrt_price_upper - sqrt_price_lower)
        else:
            # Price within range
            lx = amount_x * (sqrt_price_upper * sqrt_price_current) / (sqrt_price_upper - sqrt_price_current)
            ly = amount_y / (sqrt_price_current - sqrt_price_lower)
            liquidity = min(lx, ly)
        
        return liquidity


    # Calculate USD value of liquidity
    def calculate_position_value(self, liquidity, current_price, token_x_price_usd, token_y_price_usd):
        """
        liquidity: Amount of liquidity
        current_price: Current pool token price
        token_x_price_usd: Token X price in USD
        token_y_price_usd: Token Y price in USD
        """
        amount_x = liquidity / sqrt(current_price)
        amount_y = liquidity * sqrt(current_price)
        
        total_value = (amount_x * token_x_price_usd) + (amount_y * token_y_price_usd)
        return total_value


    # Get token amounts and unclaimed fees from LP position
    def get_position_amounts(self, position_id, nft_contract, pool_contract, block_identifier='latest'):
        """
        position_id: NFT token ID
        nft_contract: Uniswap V3 NFT manager contract
        pool_contract: Uniswap V3 pool contract
        block_identifier: Target block number (optional)
        returns: (amount0, amount1, fee0, fee1) Token amounts and unclaimed fees
        """
        position = nft_contract.functions.positions(position_id).call(block_identifier=block_identifier)
        
        liquidity = position[7]  # Liquidity
        tick_lower = position[5]  # Lower price bound
        tick_upper = position[6]  # Upper price bound
        
        # Get current tick and price
        slot0 = pool_contract.functions.slot0().call(block_identifier=block_identifier)
        sqrt_price_x96 = slot0[0]
        current_tick = slot0[1]
        
        # Calculate price range
        sqrt_price_current = Decimal(sqrt_price_x96) / Decimal(2**96)
        sqrt_price_lower = Decimal(1.0001 ** (tick_lower/2))
        sqrt_price_upper = Decimal(1.0001 ** (tick_upper/2))
        
        # Calculate token amounts
        if current_tick < tick_lower:
            amount0 = liquidity * (1/sqrt_price_lower - 1/sqrt_price_upper)
            amount1 = 0
        elif current_tick > tick_upper:
            amount0 = 0
            amount1 = liquidity * (sqrt_price_upper - sqrt_price_lower)
        else:
            amount0 = liquidity * (1/sqrt_price_current - 1/sqrt_price_upper)
            amount1 = liquidity * (sqrt_price_current - sqrt_price_lower)
        
        # Get unclaimed fees
        MAX_UINT128 = 2**128 - 1
        
        # Construct collect parameters
        collect_params = {
            'tokenId': position_id,
            'recipient': '0x0000000000000000000000000000000000000000',  # Address doesn't matter as this is a static call
            'amount0Max': MAX_UINT128,
            'amount1Max': MAX_UINT128
        }
        
        # Use callStatic to simulate collect call with block parameter
        try:
            unclaimed_fees = nft_contract.functions.collect(collect_params).call(block_identifier=block_identifier)
            fee0, fee1 = unclaimed_fees[0], unclaimed_fees[1]
        except Exception as e:
            print(f"Error getting unclaimed fees at block {block_identifier}: {e}")
            fee0, fee1 = 0, 0
        
        return float(amount0), float(amount1), float(fee0), float(fee1)


    # Get token price from pool
    def get_token_price_from_pool(self, pool_contract, is_token0=True, block_identifier='latest'):
        """
        pool_contract: Uniswap V3 pool contract
        is_token0: Whether to get token0 price (True for token0 price, False for token1)
        block_identifier: Target block number (optional)
        """
        token0 = pool_contract.functions.token0().call(block_identifier=block_identifier)
        token1 = pool_contract.functions.token1().call(block_identifier=block_identifier)
        
        token0_contract = self.w3.eth.contract(address=token0, abi=self.token_abi)
        token1_contract = self.w3.eth.contract(address=token1, abi=self.token_abi)
        
        decimals0 = token0_contract.functions.decimals().call(block_identifier=block_identifier)
        decimals1 = token1_contract.functions.decimals().call(block_identifier=block_identifier)
        
        slot0 = pool_contract.functions.slot0().call(block_identifier=block_identifier)
        sqrt_price_x96 = slot0[0]
        
        price = (Decimal(sqrt_price_x96) / Decimal(2**96)) ** 2
        decimal_adjustment = Decimal(10 ** (decimals0 - decimals1))
        actual_price = price * decimal_adjustment
        
        return float(actual_price), decimals0, decimals1


    # Get contract ABI
    def get_contract_abi(self, contract_address, chain):
        """
        contract_address: Contract address
        """
        if chain == 'arbitrum':
            end_point = "https://api.arbiscan.io/api"
        elif chain == 'eth':
            end_point = "https://api.etherscan.io/api"
        
        params = {
            'module': 'contract',
            'action': 'getabi',
            'address': contract_address,
            'apikey': self.api_key
        }
        
        try:
            response = requests.get(end_point, params=params)
            response_json = response.json()
            if response_json['status'] == '1':
                return json.loads(response_json['result'])
            else:
                raise Exception(f"Error getting ABI: {contract_address} {response_json['result']}")
        except Exception as e:
            print(f"Error: {e}")
            return None


    # Calculate LP position value
    def main(self, position_manager_address, pool_address, position_id, 
             block_number=None, pool_x_u_address='', pool_y_u_address=''):
        """
        position_manager_address: Uniswap V3 Position Manager address
        pool_address: Pool contract address
        position_id: NFT Position ID
        block_number: Target block number (optional)
        pool_x_u_address: Token0-USDC pool address
        pool_y_u_address: Token1-USDC pool address
        """
        position_manager_address = self.w3.to_checksum_address(position_manager_address)
        pool_address = self.w3.to_checksum_address(pool_address)

        # Create block parameter
        block_identifier = block_number if block_number is not None else 'latest'

        # Get contract ABI
        with open(r'asset\abi\ERC20\position_manager_address.json', 'r') as f:
            position_abi = json.load(f)
        with open(r'asset\abi\ERC20\pool_address.json', 'r') as f:
            pool_abi = json.load(f)

        nft_contract = self.w3.eth.contract(address=position_manager_address, abi=position_abi)
        pool_contract = self.w3.eth.contract(address=pool_address, abi=pool_abi)
        
        # Get token amounts and unclaimed fees
        amount_x, amount_y, fee_x, fee_y = self.get_position_amounts(
            position_id, 
            nft_contract, 
            pool_contract,
            block_identifier
        )
        
        token_price, decimals0, decimals1 = self.get_token_price_from_pool(
            pool_contract,
            block_identifier=block_identifier
        )

        if pool_x_u_address:
            pool_x_contract = self.w3.eth.contract(address=pool_x_u_address, abi=pool_abi)
            token_x_u_price = self.get_token_price_from_pool(pool_x_contract, block_identifier=block_identifier)[0]
        else:
            token_x_u_price = token_price
            
        if pool_y_u_address:
            pool_y_contract = self.w3.eth.contract(address=pool_y_u_address, abi=pool_abi)
            token_y_u_price = self.get_token_price_from_pool(pool_y_contract, block_identifier=block_identifier)[0]
        else:
            token_y_u_price = 1

        sqrt_price_current = sqrt(token_price)
        sqrt_price_lower = sqrt(self.price_lower)
        sqrt_price_upper = sqrt(self.price_upper)
        
        # Calculate main liquidity value
        liquidity = self.calculate_v3_liquidity(
            amount_x / (10 ** decimals0),
            amount_y / (10 ** decimals1), 
            sqrt_price_current,
            sqrt_price_lower,
            sqrt_price_upper
        )
        
        position_value = self.calculate_position_value(
            liquidity,
            token_price,
            token_x_u_price,
            token_y_u_price
        )
        
        # Calculate value of unclaimed fees
        fee_value = (fee_x * token_x_u_price / (10 ** decimals0)) + (fee_y * token_y_u_price / (10 ** decimals1))
        total_value = position_value + fee_value
        
        return {
            'block_number': block_number if block_number is not None else self.w3.eth.block_number,
            'token_price': token_price,
            'token_x_price': token_x_u_price,
            'token_y_price': token_y_u_price,
            'position_value': position_value,
            'unclaimed_fees': fee_value,
            'total_value': total_value
        }


if __name__ == "__main__":
    # Load configuration
    with open('config.json', 'r') as f:
        config = json.load(f)
    
    # Set proxy if configured
    if config['proxy']['http'] and config['proxy']['https']:
        os.environ["http_proxy"] = config['proxy']['http']
        os.environ["https_proxy"] = config['proxy']['https']
    
    # Create client instance
    client = v3_lp_value(config['network']['rpc'], config['network']['api_key'])
    client.price_lower = config['position']['price_lower']
    client.price_upper = config['position']['price_upper']
    
    # Calculate LP value
    result = client.main(
        position_manager_address=config['contracts']['position_manager'],
        pool_address=config['contracts']['pool'],
        position_id=config['position']['id'],
        block_number=config['query']['block_number']
    )
    
    # Print results
    print(f"Block Number: {result['block_number']}")
    print(f"Pool Price: {result['token_price']:.4f}")
    print(f"Token X Price: {result['token_x_price']:.4f}")
    print(f"Token Y Price: {result['token_y_price']:.4f}")
    print(f"Position Value: ${result['position_value']:.2f}")
    print(f"Unclaimed Fees: ${result['unclaimed_fees']:.6f}")
    print(f"Total Value: ${result['total_value']:.2f}")
